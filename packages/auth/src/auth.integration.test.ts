import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createDatabasePool, type DatabasePool } from "@reservation/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { hashPassword } from "./password.js";
import {
  authorizeRestaurant,
  createMemberAccount,
  deactivateUser,
  loginWithPassword,
  logout,
} from "./service.js";
import type { RestaurantRole } from "./types.js";

const secret = new TextEncoder().encode("integration-test-session-secret-32-chars-minimum");
let pool: DatabasePool;
const restaurantIds: string[] = [];
const userIds: string[] = [];

async function createRestaurant(): Promise<string> {
  const id = randomUUID();
  restaurantIds.push(id);
  await pool.query(
    "INSERT INTO restaurants (id, name, timezone, currency) VALUES ($1, $2, 'Asia/Taipei', 'TWD')",
    [id, `auth-${id}`],
  );
  return id;
}

async function createUser(input: {
  restaurantId: string;
  role: RestaurantRole;
  active?: boolean;
  email?: string;
  password?: string;
}): Promise<{ userId: string; email: string; password: string }> {
  const userId = randomUUID();
  const email = input.email ?? `${userId}@example.invalid`;
  const password = input.password ?? "Strong-Test-Password!42";
  userIds.push(userId);
  await pool.query(
    `INSERT INTO users (id, email, display_name, active, email_verified)
     VALUES ($1, $2, '테스트 직원', $3, TRUE)`,
    [userId, email, input.active ?? true],
  );
  await pool.query(
    "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
    [userId, await hashPassword(password)],
  );
  await pool.query(
    "INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES ($1, $2, $3)",
    [input.restaurantId, userId, input.role],
  );
  return { userId, email, password };
}

beforeAll(() => {
  pool = createDatabasePool();
});

afterAll(async () => {
  if (restaurantIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE restaurant_id = ANY($1::uuid[])", [restaurantIds]);
  }
  if (userIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  }
  if (restaurantIds.length) {
    await pool.query("DELETE FROM restaurants WHERE id = ANY($1::uuid[])", [restaurantIds]);
  }
  await pool.end();
});

describe("authentication and restaurant authorization", () => {
  it("creates a session and enforces live restaurant membership and role", async () => {
    const restaurantId = await createRestaurant();
    const otherRestaurantId = await createRestaurant();
    const user = await createUser({ restaurantId, role: "STAFF" });
    const login = await loginWithPassword({ pool, email: user.email, password: user.password, secret });

    await expect(authorizeRestaurant({
      pool,
      token: login.token,
      secret,
      restaurantId,
      minimumRole: "STAFF",
    })).resolves.toMatchObject({ userId: user.userId, role: "STAFF" });
    await expect(authorizeRestaurant({
      pool,
      token: login.token,
      secret,
      restaurantId,
      minimumRole: "MANAGER",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authorizeRestaurant({
      pool,
      token: login.token,
      secret,
      restaurantId: otherRestaurantId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("persists failed attempts, locks the account, and rejects inactive users", async () => {
    const restaurantId = await createRestaurant();
    const user = await createUser({ restaurantId, role: "STAFF" });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(loginWithPassword({
        pool,
        email: user.email,
        password: "wrong-password",
        secret,
      })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(loginWithPassword({
      pool,
      email: user.email,
      password: "wrong-password",
      secret,
    })).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    const attempts = await pool.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      "SELECT failed_login_attempts, locked_until FROM users WHERE id = $1",
      [user.userId],
    );
    expect(attempts.rows[0]).toMatchObject({ failed_login_attempts: 5 });
    expect(attempts.rows[0]?.locked_until).toBeInstanceOf(Date);

    const inactive = await createUser({ restaurantId, role: "STAFF", active: false });
    await expect(loginWithPassword({
      pool,
      email: inactive.email,
      password: inactive.password,
      secret,
    })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("revokes a database session on logout", async () => {
    const restaurantId = await createRestaurant();
    const user = await createUser({ restaurantId, role: "STAFF" });
    const login = await loginWithPassword({ pool, email: user.email, password: user.password, secret });
    await logout({ pool, token: login.token, secret });
    await expect(authorizeRestaurant({ pool, token: login.token, secret, restaurantId }))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("creates staff without writing the password to audit data", async () => {
    const restaurantId = await createRestaurant();
    const manager = await createUser({ restaurantId, role: "MANAGER" });
    const login = await loginWithPassword({ pool, email: manager.email, password: manager.password, secret });
    const created = await createMemberAccount({
      pool,
      actorToken: login.token,
      secret,
      restaurantId,
      email: `${randomUUID()}@example.invalid`,
      displayName: "새 직원",
      password: "Another-Strong-Password!42",
      role: "STAFF",
    });
    userIds.push(created.userId);
    const audit = await pool.query<{ text: string }>(
      "SELECT coalesce(before_value::text, '') || coalesce(after_value::text, '') AS text FROM audit_logs WHERE target_id = $1",
      [created.userId],
    );
    expect(audit.rows[0]?.text).not.toContain("Another-Strong-Password!42");
    expect(audit.rows[0]?.text).not.toContain("password");

    await expect(createMemberAccount({
      pool,
      actorToken: login.token,
      secret,
      restaurantId,
      email: `${randomUUID()}@example.invalid`,
      displayName: "권한 초과",
      password: "Another-Strong-Password!43",
      role: "MANAGER",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("redacts nested secrets in audit values", async () => {
    const restaurantId = await createRestaurant();
    const actor = await createUser({ restaurantId, role: "SYSTEM_ADMIN" });
    const client = await pool.connect();
    try {
      const { writeAuditLog } = await import("./audit.js");
      await writeAuditLog(client, {
        restaurantId,
        actorUserId: actor.userId,
        action: "REDACTION_TEST",
        targetType: "USER",
        targetId: actor.userId,
        afterValue: { profile: { password: "must-not-appear", token: "also-secret" } },
      });
    } finally {
      client.release();
    }
    const audit = await pool.query<{ value: Record<string, unknown> }>(
      "SELECT after_value AS value FROM audit_logs WHERE action = 'REDACTION_TEST' AND target_id = $1",
      [actor.userId],
    );
    expect(JSON.stringify(audit.rows[0]?.value)).not.toContain("must-not-appear");
    expect(JSON.stringify(audit.rows[0]?.value)).not.toContain("also-secret");
    expect(JSON.stringify(audit.rows[0]?.value)).toContain("[REDACTED]");
  });

  it("lets a system administrator deactivate an account and revoke all sessions", async () => {
    const restaurantId = await createRestaurant();
    const administrator = await createUser({ restaurantId, role: "SYSTEM_ADMIN" });
    const staff = await createUser({ restaurantId, role: "STAFF" });
    const adminLogin = await loginWithPassword({ pool, email: administrator.email, password: administrator.password, secret });
    const staffLogin = await loginWithPassword({ pool, email: staff.email, password: staff.password, secret });

    await deactivateUser({
      pool,
      actorToken: adminLogin.token,
      secret,
      restaurantId,
      targetUserId: staff.userId,
      reason: "integration test",
    });
    await expect(authorizeRestaurant({ pool, token: staffLogin.token, secret, restaurantId }))
      .rejects.toBeInstanceOf(AuthError);
    const audit = await pool.query<{ action: string; reason: string }>(
      "SELECT action, reason FROM audit_logs WHERE target_id = $1 AND action = 'USER_DEACTIVATED'",
      [staff.userId],
    );
    expect(audit.rows[0]).toEqual({ action: "USER_DEACTIVATED", reason: "integration test" });
  });
});
