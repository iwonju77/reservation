import { randomUUID } from "node:crypto";
import { authorizeRestaurant, writeAuditLog } from "@reservation/auth";
import type { DatabasePool } from "@reservation/db";
import type { PoolClient } from "pg";
import { OperationsError } from "./operations-error";
import type { BusinessPeriodInput, PolicyRuleInput } from "./types";

type AuthorizedInput = { pool: DatabasePool; actorToken: string; secret: Uint8Array; restaurantId: string };

async function transaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function manager(input: AuthorizedInput) {
  return authorizeRestaurant({
    pool: input.pool,
    token: input.actorToken,
    secret: input.secret,
    restaurantId: input.restaurantId,
    minimumRole: "MANAGER",
  });
}

function minutes(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) throw new OperationsError("INVALID_CONFIGURATION", "Time must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new OperationsError("INVALID_CONFIGURATION", "Time is outside a day");
  return hour * 60 + minute;
}

function validateBusinessPeriods(periods: BusinessPeriodInput[]): void {
  const week = 7 * 1_440;
  const intervals = periods.map((period, index) => {
    if (!Number.isInteger(period.weekday) || period.weekday < 0 || period.weekday > 6) {
      throw new OperationsError("INVALID_CONFIGURATION", "Weekday must be between 0 and 6");
    }
    const start = period.weekday * 1_440 + minutes(period.opensAt);
    const end = period.weekday * 1_440 + minutes(period.closesAt) + period.closesDayOffset * 1_440;
    if (end <= start) throw new OperationsError("INVALID_CONFIGURATION", "Closing time must follow opening time");
    return { start, end, index };
  });
  for (let left = 0; left < intervals.length; left += 1) {
    for (let right = left + 1; right < intervals.length; right += 1) {
      const a = intervals[left]; const b = intervals[right];
      if (!a || !b) continue;
      const overlaps = [-week, 0, week].some((shift) => a.start < b.end + shift && b.start + shift < a.end);
      if (overlaps) throw new OperationsError("INVALID_CONFIGURATION", "Business periods overlap", { left: a.index, right: b.index });
    }
  }
}

function validateRules(rules: PolicyRuleInput[]): void {
  const singleton = ["BOOKING_WINDOW", "PARTY_LIMIT", "DURATION", "START_INTERVAL"];
  for (const type of singleton) {
    if (!rules.some((rule) => rule.ruleType === type)) {
      throw new OperationsError("INVALID_CONFIGURATION", `Policy requires ${type}`);
    }
  }
  for (const rule of rules) {
    if (rule.weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new OperationsError("INVALID_CONFIGURATION", "Rule weekday is invalid");
    }
    if (rule.minPartySize && rule.maxPartySize && rule.maxPartySize < rule.minPartySize) {
      throw new OperationsError("INVALID_CONFIGURATION", "Party size range is invalid");
    }
    if (["DURATION", "CLEANUP", "START_INTERVAL"].includes(rule.ruleType) && (!rule.durationMinutes || rule.durationMinutes <= 0)) {
      throw new OperationsError("INVALID_CONFIGURATION", `${rule.ruleType} requires positive durationMinutes`);
    }
    if (["MINIMUM_SPEND", "DEPOSIT"].includes(rule.ruleType) && (rule.amountMinor === undefined || rule.amountMinor < 0)) {
      throw new OperationsError("INVALID_CONFIGURATION", `${rule.ruleType} requires non-negative amountMinor`);
    }
  }
}

export async function createDiningTable(input: AuthorizedInput & {
  name: string; defaultSeats: number; maxSeats: number; zone?: string | undefined; notes?: string | undefined;
}): Promise<{ id: string }> {
  const actor = await manager(input);
  if (!input.name.trim() || input.defaultSeats < 1 || input.maxSeats < input.defaultSeats) {
    throw new OperationsError("INVALID_CONFIGURATION", "Table capacity is invalid");
  }
  return transaction(input.pool, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO dining_tables (id, restaurant_id, name, default_seats, max_seats, zone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.restaurantId, input.name.trim(), input.defaultSeats, input.maxSeats, input.zone ?? null, input.notes ?? null],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "DINING_TABLE_CREATED", targetType: "DINING_TABLE", targetId: id, afterValue: { name: input.name.trim(), defaultSeats: input.defaultSeats, maxSeats: input.maxSeats } });
    return { id };
  });
}

export async function updateDiningTable(input: AuthorizedInput & {
  tableId: string; name: string; defaultSeats: number; maxSeats: number; active: boolean; confirmImpact?: boolean | undefined;
}): Promise<void> {
  const actor = await manager(input);
  if (!input.name.trim() || input.defaultSeats < 1 || input.maxSeats < input.defaultSeats) {
    throw new OperationsError("INVALID_CONFIGURATION", "Table capacity is invalid");
  }
  await transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.restaurantId]);
    const current = await client.query<{ name: string; inactive_at: Date | null }>(
      "SELECT name, inactive_at FROM dining_tables WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [input.tableId, input.restaurantId],
    );
    if (!current.rows[0]) throw new OperationsError("NOT_FOUND", "Table was not found");
    if (!input.active) {
      const impact = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM reservation_allocations ra JOIN reservations r ON r.id = ra.reservation_id
         WHERE ra.restaurant_id = $1 AND ra.table_id = $2 AND ra.released_at IS NULL
           AND r.ends_at > CURRENT_TIMESTAMP AND r.status NOT IN ('CANCELLED','EXPIRED','COMPLETED')`,
        [input.restaurantId, input.tableId],
      );
      if (Number(impact.rows[0]?.count ?? 0) > 0 && !input.confirmImpact) {
        throw new OperationsError("IMPACT_CONFIRMATION_REQUIRED", "Future reservations use this table", { reservations: Number(impact.rows[0]?.count) });
      }
    }
    await client.query(
      `UPDATE dining_tables SET name=$3, default_seats=$4, max_seats=$5,
       inactive_at=CASE WHEN $6 THEN NULL ELSE COALESCE(inactive_at, CURRENT_TIMESTAMP) END, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND restaurant_id=$2`,
      [input.tableId, input.restaurantId, input.name.trim(), input.defaultSeats, input.maxSeats, input.active],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "DINING_TABLE_UPDATED", targetType: "DINING_TABLE", targetId: input.tableId, beforeValue: current.rows[0], afterValue: { name: input.name.trim(), defaultSeats: input.defaultSeats, maxSeats: input.maxSeats, active: input.active } });
  });
}

export async function createTableCombination(input: AuthorizedInput & { name: string; tableIds: string[]; maxSeats: number }): Promise<{ id: string }> {
  const actor = await manager(input);
  const ids = [...new Set(input.tableIds)];
  if (ids.length < 2 || ids.length !== input.tableIds.length) throw new OperationsError("INVALID_CONFIGURATION", "A combination needs distinct tables");
  return transaction(input.pool, async (client) => {
    const tables = await client.query<{ id: string; max_seats: number }>(
      `SELECT id, max_seats FROM dining_tables WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) AND inactive_at IS NULL FOR SHARE`,
      [input.restaurantId, ids],
    );
    if (tables.rowCount !== ids.length) throw new OperationsError("INVALID_CONFIGURATION", "All combination members must be active tables in this restaurant");
    const capacity = tables.rows.reduce((sum, table) => sum + table.max_seats, 0);
    if (input.maxSeats < 1 || input.maxSeats > capacity) throw new OperationsError("INVALID_CONFIGURATION", "Combination capacity exceeds member capacity");
    const id = randomUUID();
    await client.query("INSERT INTO table_combinations (id, restaurant_id, name, max_seats) VALUES ($1,$2,$3,$4)", [id, input.restaurantId, input.name.trim(), input.maxSeats]);
    for (const [position, tableId] of ids.entries()) await client.query(
      "INSERT INTO table_combination_members (combination_id, table_id, restaurant_id, position) VALUES ($1,$2,$3,$4)", [id, tableId, input.restaurantId, position + 1],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "TABLE_COMBINATION_CREATED", targetType: "TABLE_COMBINATION", targetId: id, afterValue: { name: input.name.trim(), tableIds: ids, maxSeats: input.maxSeats } });
    return { id };
  });
}

export async function updateTableCombination(input: AuthorizedInput & { combinationId: string; name: string; tableIds: string[]; maxSeats: number; active: boolean }): Promise<void> {
  const actor = await manager(input); const ids = [...new Set(input.tableIds)];
  if (ids.length < 2 || ids.length !== input.tableIds.length) throw new OperationsError("INVALID_CONFIGURATION", "A combination needs distinct tables");
  await transaction(input.pool, async (client) => {
    const combination = await client.query("SELECT id FROM table_combinations WHERE id=$1 AND restaurant_id=$2 FOR UPDATE", [input.combinationId, input.restaurantId]);
    if (!combination.rowCount) throw new OperationsError("NOT_FOUND", "Combination was not found");
    const tables = await client.query<{ id: string; max_seats: number }>("SELECT id,max_seats FROM dining_tables WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) AND inactive_at IS NULL FOR SHARE", [input.restaurantId, ids]);
    if (tables.rowCount !== ids.length) throw new OperationsError("INVALID_CONFIGURATION", "All combination members must be active tables in this restaurant");
    if (input.maxSeats < 1 || input.maxSeats > tables.rows.reduce((sum, table) => sum + table.max_seats, 0)) throw new OperationsError("INVALID_CONFIGURATION", "Combination capacity exceeds member capacity");
    await client.query("UPDATE table_combinations SET name=$3,max_seats=$4,active=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND restaurant_id=$2", [input.combinationId, input.restaurantId, input.name.trim(), input.maxSeats, input.active]);
    await client.query("DELETE FROM table_combination_members WHERE combination_id=$1", [input.combinationId]);
    for (const [position, tableId] of ids.entries()) await client.query("INSERT INTO table_combination_members (combination_id,table_id,restaurant_id,position) VALUES ($1,$2,$3,$4)", [input.combinationId, tableId, input.restaurantId, position + 1]);
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "TABLE_COMBINATION_UPDATED", targetType: "TABLE_COMBINATION", targetId: input.combinationId, afterValue: { name: input.name.trim(), tableIds: ids, maxSeats: input.maxSeats, active: input.active } });
  });
}

export async function replaceBusinessHours(input: AuthorizedInput & { periods: BusinessPeriodInput[] }): Promise<void> {
  validateBusinessPeriods(input.periods); const actor = await manager(input);
  await transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.restaurantId]);
    await client.query("DELETE FROM business_hours WHERE restaurant_id=$1", [input.restaurantId]);
    for (const period of input.periods) await client.query(
      `INSERT INTO business_hours (restaurant_id, weekday, opens_at, closes_at, closes_day_offset)
       VALUES ($1,$2,$3,$4,$5)`, [input.restaurantId, period.weekday, period.opensAt, period.closesAt, period.closesDayOffset],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "BUSINESS_HOURS_REPLACED", targetType: "RESTAURANT", targetId: input.restaurantId, afterValue: { periods: input.periods } });
  });
}

export async function setSpecialBusinessDate(input: AuthorizedInput & { businessDate: string; kind: "CLOSED" | "SPECIAL_OPEN"; reason?: string | undefined; periods?: Omit<BusinessPeriodInput, "weekday">[] | undefined }): Promise<{ id: string }> {
  const actor = await manager(input); const periods = input.periods ?? [];
  if (input.kind === "CLOSED" && periods.length) throw new OperationsError("INVALID_CONFIGURATION", "Closed dates cannot contain periods");
  if (input.kind === "SPECIAL_OPEN" && !periods.length) throw new OperationsError("INVALID_CONFIGURATION", "Special opening requires a period");
  validateBusinessPeriods(periods.map((period) => ({ ...period, weekday: 0 })));
  return transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.restaurantId]);
    const result = await client.query<{ id: string }>(
      `INSERT INTO special_business_dates (restaurant_id,business_date,kind,reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT (restaurant_id,business_date) DO UPDATE SET kind=EXCLUDED.kind,reason=EXCLUDED.reason RETURNING id`,
      [input.restaurantId, input.businessDate, input.kind, input.reason ?? null],
    );
    const id = result.rows[0]?.id; if (!id) throw new Error("Special date was not returned");
    await client.query("DELETE FROM special_business_periods WHERE special_date_id=$1", [id]);
    for (const period of periods) await client.query(
      `INSERT INTO special_business_periods (special_date_id,restaurant_id,opens_at,closes_at,closes_day_offset) VALUES ($1,$2,$3,$4,$5)`,
      [id, input.restaurantId, period.opensAt, period.closesAt, period.closesDayOffset],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "SPECIAL_BUSINESS_DATE_SET", targetType: "SPECIAL_BUSINESS_DATE", targetId: id, afterValue: { businessDate: input.businessDate, kind: input.kind, periods } });
    return { id };
  });
}

export async function createReservationBlock(input: AuthorizedInput & { tableId?: string | undefined; startsAt: Date; endsAt: Date; reason: string }): Promise<{ id: string }> {
  const actor = await manager(input);
  if (input.endsAt <= input.startsAt || !input.reason.trim()) throw new OperationsError("INVALID_CONFIGURATION", "Block period is invalid");
  return transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.restaurantId]);
    const impact = await client.query<{ count: string }>(
      `SELECT count(DISTINCT reservation_id)::text AS count FROM reservation_allocations
       WHERE restaurant_id=$1 AND released_at IS NULL AND occupied_period && tstzrange($2,$3,'[)')
         AND ($4::uuid IS NULL OR table_id=$4)`,
      [input.restaurantId,input.startsAt,input.endsAt,input.tableId ?? null],
    );
    if (Number(impact.rows[0]?.count ?? 0)>0) throw new OperationsError("IMPACT_CONFIRMATION_REQUIRED","Existing reservations overlap this block",{reservations:Number(impact.rows[0]?.count)});
    const id = randomUUID();
    await client.query(
      `INSERT INTO reservation_blocks (id,restaurant_id,table_id,blocked_period,reason,created_by)
       VALUES ($1,$2,$3,tstzrange($4,$5,'[)'),$6,$7)`,
      [id, input.restaurantId, input.tableId ?? null, input.startsAt, input.endsAt, input.reason.trim(), actor.userId],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "RESERVATION_BLOCK_CREATED", targetType: "RESERVATION_BLOCK", targetId: id, afterValue: { tableId: input.tableId ?? null, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), reason: input.reason.trim() } });
    return { id };
  });
}

export async function createPolicyDraft(input: AuthorizedInput & { name: string; description?: string | undefined; rules: PolicyRuleInput[] }): Promise<{ id: string; version: number }> {
  validateRules(input.rules); const actor = await manager(input);
  return transaction(input.pool, async (client) => {
    await client.query("SELECT id FROM restaurants WHERE id=$1 FOR UPDATE", [input.restaurantId]);
    const versionResult = await client.query<{ version: number }>("SELECT COALESCE(max(version),0)+1 AS version FROM policy_versions WHERE restaurant_id=$1", [input.restaurantId]);
    const version = versionResult.rows[0]?.version ?? 1; const id = randomUUID();
    await client.query("INSERT INTO policy_versions (id,restaurant_id,version,status,name,description) VALUES ($1,$2,$3,'DRAFT',$4,$5)", [id, input.restaurantId, version, input.name.trim(), input.description ?? null]);
    for (const rule of input.rules) await client.query(
      `INSERT INTO reservation_policy_rules
       (policy_version_id,rule_type,priority,weekdays,local_start,local_end,min_party_size,max_party_size,duration_minutes,amount_minor,value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, rule.ruleType, rule.priority ?? 0, rule.weekdays ?? null, rule.localStart ?? null, rule.localEnd ?? null, rule.minPartySize ?? null, rule.maxPartySize ?? null, rule.durationMinutes ?? null, rule.amountMinor ?? null, JSON.stringify(rule.value ?? {})],
    );
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "POLICY_DRAFT_CREATED", targetType: "POLICY_VERSION", targetId: id, afterValue: { version, name: input.name.trim(), ruleCount: input.rules.length } });
    return { id, version };
  });
}

export async function publishPolicy(input: AuthorizedInput & { policyId: string; validFrom: string; validUntil?: string | undefined }): Promise<void> {
  const actor = await manager(input);
  if (input.validUntil && input.validUntil <= input.validFrom) throw new OperationsError("INVALID_CONFIGURATION", "Policy end date must follow its start date");
  await transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.restaurantId]);
    const policy = await client.query<{ status: string }>("SELECT status FROM policy_versions WHERE id=$1 AND restaurant_id=$2 FOR UPDATE", [input.policyId, input.restaurantId]);
    if (!policy.rows[0]) throw new OperationsError("NOT_FOUND", "Policy was not found");
    if (policy.rows[0].status !== "DRAFT") throw new OperationsError("INVALID_CONFIGURATION", "Only a draft can be published");
    try {
      await client.query(
        `INSERT INTO policy_schedules (restaurant_id,policy_version_id,valid_during)
         VALUES ($1,$2,daterange($3::date,$4::date,'[)'))`,
        [input.restaurantId, input.policyId, input.validFrom, input.validUntil ?? null],
      );
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23P01") throw new OperationsError("POLICY_CONFLICT", "Policy schedule overlaps an existing policy");
      throw error;
    }
    await client.query("UPDATE policy_versions SET status='PUBLISHED',published_by=$3,published_at=CURRENT_TIMESTAMP WHERE id=$1 AND restaurant_id=$2", [input.policyId, input.restaurantId, actor.userId]);
    await writeAuditLog(client, { restaurantId: input.restaurantId, actorUserId: actor.userId, action: "POLICY_PUBLISHED", targetType: "POLICY_VERSION", targetId: input.policyId, afterValue: { validFrom: input.validFrom, validUntil: input.validUntil ?? null } });
  });
}

export async function previewPolicy(input: AuthorizedInput & { policyId: string; weekday: number; localTime: string; partySize: number }) {
  await manager(input);
  const result = await input.pool.query<{
    rule_type: PolicyRuleInput["ruleType"]; duration_minutes: number | null; amount_minor: string | null; value: Record<string, unknown>;
  }>(
    `SELECT rule_type,duration_minutes,amount_minor,value FROM reservation_policy_rules
     WHERE policy_version_id=$1 AND (weekdays IS NULL OR $2=ANY(weekdays))
       AND (min_party_size IS NULL OR min_party_size <= $3) AND (max_party_size IS NULL OR max_party_size >= $3)
       AND (local_start IS NULL OR local_start <= $4::time) AND (local_end IS NULL OR local_end > $4::time)
     ORDER BY rule_type,priority DESC`, [input.policyId, input.weekday, input.partySize, input.localTime],
  );
  if (!result.rowCount) throw new OperationsError("NOT_FOUND", "No matching policy rules");
  return { policyId: input.policyId, input: { weekday: input.weekday, localTime: input.localTime, partySize: input.partySize }, rules: result.rows.map((row) => ({ ruleType: row.rule_type, durationMinutes: row.duration_minutes, amountMinor: row.amount_minor === null ? null : Number(row.amount_minor), value: row.value })) };
}

export async function getOperationsConfiguration(input: AuthorizedInput) {
  await manager(input);
  const [tables, combinations, hours, specialDates, policies, blocks] = await Promise.all([
    input.pool.query("SELECT id,name,default_seats,max_seats,zone,notes,inactive_at FROM dining_tables WHERE restaurant_id=$1 ORDER BY name", [input.restaurantId]),
    input.pool.query(`SELECT tc.id,tc.name,tc.max_seats,tc.active,array_agg(tcm.table_id ORDER BY tcm.position) AS table_ids FROM table_combinations tc JOIN table_combination_members tcm ON tcm.combination_id=tc.id WHERE tc.restaurant_id=$1 GROUP BY tc.id ORDER BY tc.name`, [input.restaurantId]),
    input.pool.query("SELECT id,weekday,opens_at,closes_at,closes_day_offset FROM business_hours WHERE restaurant_id=$1 AND active=TRUE ORDER BY weekday,opens_at", [input.restaurantId]),
    input.pool.query("SELECT id,business_date,kind,reason FROM special_business_dates WHERE restaurant_id=$1 ORDER BY business_date", [input.restaurantId]),
    input.pool.query("SELECT id,version,status,name,description,published_at FROM policy_versions WHERE restaurant_id=$1 ORDER BY version DESC", [input.restaurantId]),
    input.pool.query("SELECT id,table_id,blocked_period,reason FROM reservation_blocks WHERE restaurant_id=$1 AND upper(blocked_period)>CURRENT_TIMESTAMP ORDER BY lower(blocked_period)", [input.restaurantId]),
  ]);
  const activeTables = tables.rows.filter((table) => !(table as { inactive_at: Date | null }).inactive_at) as Array<{ default_seats: number; max_seats: number }>;
  return {
    summary: {
      activeTableCount: activeTables.length,
      activeDefaultSeats: activeTables.reduce((sum, table) => sum + table.default_seats, 0),
      activeMaxSeats: activeTables.reduce((sum, table) => sum + table.max_seats, 0),
    },
    tables: tables.rows, combinations: combinations.rows, businessHours: hours.rows,
    specialDates: specialDates.rows, policies: policies.rows, blocks: blocks.rows,
  };
}
