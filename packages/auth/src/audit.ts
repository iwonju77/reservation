import type { PoolClient } from "pg";

export type AuditEntry = {
  restaurantId?: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  reason?: string;
  beforeValue?: Record<string, unknown>;
  afterValue?: Record<string, unknown>;
};

const sensitiveKey = /(?:password|secret|token|authorization|cookie|credential)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(nested),
      ]),
    );
  }
  return value;
}

export async function writeAuditLog(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (restaurant_id, actor_user_id, action, target_type, target_id, reason,
        before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      entry.restaurantId ?? null,
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.reason ?? null,
      entry.beforeValue ? JSON.stringify(redact(entry.beforeValue)) : null,
      entry.afterValue ? JSON.stringify(redact(entry.afterValue)) : null,
    ],
  );
}
