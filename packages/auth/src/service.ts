import { randomUUID } from "node:crypto";
import type { DatabasePool } from "@reservation/db";
import type { PoolClient } from "pg";
import { writeAuditLog } from "./audit";
import { AuthError } from "./errors";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken, verifySessionToken } from "./token";
import type { AuthenticatedUser, AuthorizedContext, Membership, RestaurantRole } from "./types";

const SESSION_DURATION_MS = 8 * 60 * 60 * 1_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1_000;
const roleRank: Record<RestaurantRole, number> = { STAFF: 1, MANAGER: 2, SYSTEM_ADMIN: 3 };

type LoginRow = {
  id: string;
  display_name: string;
  active: boolean;
  password_hash: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
};

async function transaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function membershipsFor(client: PoolClient, userId: string): Promise<Membership[]> {
  const result = await client.query<{
    restaurant_id: string;
    restaurant_name: string;
    role: RestaurantRole;
  }>(
    `SELECT rm.restaurant_id, r.name AS restaurant_name, rm.role
     FROM restaurant_members rm
     JOIN restaurants r ON r.id = rm.restaurant_id
     WHERE rm.user_id = $1 AND rm.active = TRUE
     ORDER BY r.name, rm.role`,
    [userId],
  );
  return result.rows.map((row) => ({
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    role: row.role,
  }));
}

export async function loginWithPassword(input: {
  pool: DatabasePool;
  email: string;
  password: string;
  secret: Uint8Array;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date; user: AuthenticatedUser }> {
  const now = input.now ?? new Date();
  const outcome = await transaction(input.pool, async (client) => {
    const userResult = await client.query<LoginRow>(
      `SELECT u.id, u.display_name, u.active, u.failed_login_attempts, u.locked_until,
              pc.password_hash
       FROM users u
       LEFT JOIN password_credentials pc ON pc.user_id = u.id
       WHERE lower(u.email) = lower($1)
       FOR UPDATE OF u`,
      [input.email.trim()],
    );
    const user = userResult.rows[0];
    const passwordValid = await verifyPassword(input.password, user?.password_hash ?? undefined);

    if (!user || !user.active || !user.password_hash || !passwordValid) {
      if (user?.active) {
        const attempts = user.failed_login_attempts + 1;
        const lockedUntil = attempts >= MAX_FAILED_LOGINS
          ? new Date(now.getTime() + LOCK_DURATION_MS)
          : null;
        await client.query(
          `UPDATE users SET failed_login_attempts = $2, locked_until = $3, updated_at = $4
           WHERE id = $1`,
          [user.id, attempts, lockedUntil, now],
        );
        if (lockedUntil) {
          return { error: new AuthError("ACCOUNT_LOCKED", "Account is temporarily locked") } as const;
        }
      }
      return { error: new AuthError("INVALID_CREDENTIALS", "Email or password is invalid") } as const;
    }
    if (user.locked_until && user.locked_until > now) {
      return { error: new AuthError("ACCOUNT_LOCKED", "Account is temporarily locked") } as const;
    }

    const memberships = await membershipsFor(client, user.id);
    if (memberships.length === 0) {
      return { error: new AuthError("FORBIDDEN", "No active restaurant membership") } as const;
    }

    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
    const token = await createSessionToken({ sessionId, userId: user.id, expiresAt, secret: input.secret });
    await client.query(
      `INSERT INTO auth_sessions (id, user_id, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, user.id, expiresAt, now],
    );
    await client.query(
      `UPDATE users
       SET failed_login_attempts = 0, locked_until = NULL, last_login_at = $2, updated_at = $2
       WHERE id = $1`,
      [user.id, now],
    );
    await writeAuditLog(client, {
      actorUserId: user.id,
      action: "AUTH_LOGIN",
      targetType: "USER",
      targetId: user.id,
    });
    return { value: {
      token,
      expiresAt,
      user: { userId: user.id, displayName: user.display_name, memberships },
    } } as const;
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

export async function authorizeRestaurant(input: {
  pool: DatabasePool;
  token: string;
  secret: Uint8Array;
  restaurantId: string;
  minimumRole?: RestaurantRole;
  now?: Date;
}): Promise<AuthorizedContext> {
  let payload: { sessionId: string; userId: string };
  try {
    payload = await verifySessionToken(input.token, input.secret);
  } catch {
    throw new AuthError("UNAUTHENTICATED", "Session is invalid");
  }
  const now = input.now ?? new Date();
  const result = await input.pool.query<{
    session_id: string;
    user_id: string;
    display_name: string;
    role: RestaurantRole | null;
    mfa_required: boolean;
    mfa_verified_at: Date | null;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.display_name, rm.role,
            u.mfa_required, s.mfa_verified_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN restaurant_members rm
       ON rm.user_id = u.id AND rm.restaurant_id = $3 AND rm.active = TRUE
     WHERE s.id = $1 AND s.user_id = $2
       AND s.revoked_at IS NULL AND s.expires_at > $4
       AND u.active = TRUE`,
    [payload.sessionId, payload.userId, input.restaurantId, now],
  );
  const row = result.rows[0];
  if (!row) throw new AuthError("UNAUTHENTICATED", "Session is inactive");
  if (!row.role) throw new AuthError("FORBIDDEN", "No active membership for this restaurant");
  if (input.minimumRole && roleRank[row.role] < roleRank[input.minimumRole]) {
    throw new AuthError("FORBIDDEN", "Role is not permitted");
  }
  if (row.mfa_required && !row.mfa_verified_at) {
    throw new AuthError("MFA_REQUIRED", "Multi-factor verification is required");
  }
  await input.pool.query(
    `UPDATE auth_sessions SET last_seen_at = $2
     WHERE id = $1 AND last_seen_at < $2::timestamptz - INTERVAL '5 minutes'`,
    [row.session_id, now],
  );
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    displayName: row.display_name,
    restaurantId: input.restaurantId,
    role: row.role,
    mfaVerified: row.mfa_verified_at !== null,
  };
}

export async function logout(input: {
  pool: DatabasePool;
  token: string;
  secret: Uint8Array;
  now?: Date;
}): Promise<void> {
  let payload: { sessionId: string; userId: string };
  try {
    payload = await verifySessionToken(input.token, input.secret);
  } catch {
    return;
  }
  const now = input.now ?? new Date();
  await transaction(input.pool, async (client) => {
    const revoked = await client.query<{ id: string }>(
      `UPDATE auth_sessions SET revoked_at = $3
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [payload.sessionId, payload.userId, now],
    );
    if (revoked.rowCount) {
      await writeAuditLog(client, {
        actorUserId: payload.userId,
        action: "AUTH_LOGOUT",
        targetType: "SESSION",
        targetId: payload.sessionId,
      });
    }
  });
}

export async function createMemberAccount(input: {
  pool: DatabasePool;
  actorToken: string;
  secret: Uint8Array;
  restaurantId: string;
  email: string;
  displayName: string;
  password: string;
  role: RestaurantRole;
}): Promise<{ userId: string }> {
  const actor = await authorizeRestaurant({
    pool: input.pool,
    token: input.actorToken,
    secret: input.secret,
    restaurantId: input.restaurantId,
    minimumRole: "MANAGER",
  });
  if (actor.role === "MANAGER" && input.role !== "STAFF") {
    throw new AuthError("FORBIDDEN", "Managers may only create staff accounts");
  }
  const passwordHash = await hashPassword(input.password);
  try {
    return await transaction(input.pool, async (client) => {
      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, display_name, email_verified)
         VALUES ($1, lower($2), $3, TRUE)`,
        [userId, input.email.trim(), input.displayName.trim()],
      );
      await client.query(
        "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
        [userId, passwordHash],
      );
      await client.query(
        `INSERT INTO restaurant_members (restaurant_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [input.restaurantId, userId, input.role],
      );
      await writeAuditLog(client, {
        restaurantId: input.restaurantId,
        actorUserId: actor.userId,
        action: "MEMBER_CREATED",
        targetType: "USER",
        targetId: userId,
        afterValue: { email: input.email.trim().toLowerCase(), role: input.role, active: true },
      });
      return { userId };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new AuthError("EMAIL_IN_USE", "Email address is already registered");
    }
    throw error;
  }
}

export async function deactivateUser(input: {
  pool: DatabasePool;
  actorToken: string;
  secret: Uint8Array;
  restaurantId: string;
  targetUserId: string;
  reason: string;
  now?: Date;
}): Promise<void> {
  const actor = await authorizeRestaurant({
    pool: input.pool,
    token: input.actorToken,
    secret: input.secret,
    restaurantId: input.restaurantId,
    minimumRole: "SYSTEM_ADMIN",
  });
  if (actor.userId === input.targetUserId) {
    throw new AuthError("FORBIDDEN", "A system administrator cannot deactivate their own account");
  }
  const now = input.now ?? new Date();
  await transaction(input.pool, async (client) => {
    const target = await client.query<{ active: boolean }>(
      `SELECT u.active
       FROM users u
       JOIN restaurant_members rm ON rm.user_id = u.id AND rm.restaurant_id = $2
       WHERE u.id = $1 FOR UPDATE OF u`,
      [input.targetUserId, input.restaurantId],
    );
    if (!target.rows[0]) throw new AuthError("FORBIDDEN", "Target user is not in this restaurant");
    await client.query("UPDATE users SET active = FALSE, updated_at = $2 WHERE id = $1", [input.targetUserId, now]);
    await client.query(
      "UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL",
      [input.targetUserId, now],
    );
    await writeAuditLog(client, {
      restaurantId: input.restaurantId,
      actorUserId: actor.userId,
      action: "USER_DEACTIVATED",
      targetType: "USER",
      targetId: input.targetUserId,
      reason: input.reason,
      beforeValue: { active: target.rows[0].active },
      afterValue: { active: false },
    });
  });
}
