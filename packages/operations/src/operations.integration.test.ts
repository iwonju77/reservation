import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createDatabasePool, type DatabasePool } from "@reservation/db";
import { hashPassword, loginWithPassword } from "@reservation/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDiningTable,
  createPolicyDraft,
  createReservationBlock,
  createTableCombination,
  getOperationsConfiguration,
  previewPolicy,
  publishPolicy,
  replaceBusinessHours,
  setSpecialBusinessDate,
  updateTableCombination,
} from "./service";

const secret = new TextEncoder().encode("operations-test-session-secret-32-characters");
let pool: DatabasePool;
const restaurantIds: string[] = [];
const userIds: string[] = [];

async function setup(role: "STAFF" | "MANAGER" = "MANAGER") {
  const restaurantId = randomUUID(); const userId = randomUUID(); const email = `${userId}@example.invalid`;
  restaurantIds.push(restaurantId); userIds.push(userId);
  await pool.query("INSERT INTO restaurants (id,name,timezone,currency) VALUES ($1,$2,'Asia/Taipei','TWD')", [restaurantId, `ops-${restaurantId}`]);
  await pool.query("INSERT INTO users (id,email,display_name,email_verified) VALUES ($1,$2,'운영자',TRUE)", [userId, email]);
  await pool.query("INSERT INTO password_credentials (user_id,password_hash) VALUES ($1,$2)", [userId, await hashPassword("Strong-Operations-Password!42")]);
  await pool.query("INSERT INTO restaurant_members (restaurant_id,user_id,role) VALUES ($1,$2,$3)", [restaurantId, userId, role]);
  const login = await loginWithPassword({ pool, email, password: "Strong-Operations-Password!42", secret });
  return { pool, actorToken: login.token, secret, restaurantId };
}

const requiredRules = [
  { ruleType: "BOOKING_WINDOW" as const, value: { opensDaysAhead: 30, cutoffMinutes: 120 } },
  { ruleType: "PARTY_LIMIT" as const, minPartySize: 1, maxPartySize: 12 },
  { ruleType: "DURATION" as const, durationMinutes: 90 },
  { ruleType: "START_INTERVAL" as const, durationMinutes: 30 },
];

beforeAll(() => { pool = createDatabasePool(); });
afterAll(async () => {
  if (restaurantIds.length) await pool.query("DELETE FROM audit_logs WHERE restaurant_id=ANY($1::uuid[])", [restaurantIds]);
  if (userIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  if (restaurantIds.length) await pool.query("DELETE FROM restaurants WHERE id=ANY($1::uuid[])", [restaurantIds]);
  await pool.end();
});

describe("operations management", () => {
  it("manages tables and validates active combination members", async () => {
    const base = await setup();
    const first = await createDiningTable({ ...base, name: "A1", defaultSeats: 2, maxSeats: 4 });
    const second = await createDiningTable({ ...base, name: "A2", defaultSeats: 4, maxSeats: 6 });
    const combination = await createTableCombination({ ...base, name: "A1+A2", tableIds: [first.id, second.id], maxSeats: 8 });
    await updateTableCombination({ ...base, combinationId: combination.id, name: "A2+A1", tableIds: [second.id, first.id], maxSeats: 9, active: true });
    const config = await getOperationsConfiguration(base);
    expect(config.tables).toHaveLength(2);
    expect(config.summary).toEqual({ activeTableCount: 2, activeDefaultSeats: 6, activeMaxSeats: 10 });
    expect(config.combinations).toEqual(expect.arrayContaining([expect.objectContaining({ id: combination.id, name: "A2+A1", max_seats: 9 })]));
    await expect(createTableCombination({ ...base, name: "duplicate", tableIds: [first.id, first.id], maxSeats: 4 }))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects overlapping weekly and overnight business hours", async () => {
    const base = await setup();
    await expect(replaceBusinessHours({ ...base, periods: [
      { weekday: 1, opensAt: "17:00", closesAt: "22:00", closesDayOffset: 0 },
      { weekday: 1, opensAt: "21:30", closesAt: "23:00", closesDayOffset: 0 },
    ] })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(replaceBusinessHours({ ...base, periods: [
      { weekday: 6, opensAt: "22:00", closesAt: "02:00", closesDayOffset: 1 },
      { weekday: 0, opensAt: "01:00", closesAt: "03:00", closesDayOffset: 0 },
    ] })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await replaceBusinessHours({ ...base, periods: [
      { weekday: 1, opensAt: "11:30", closesAt: "14:30", closesDayOffset: 0 },
      { weekday: 1, opensAt: "17:00", closesAt: "22:00", closesDayOffset: 0 },
    ] });
  });

  it("stores special openings and reservation blocks", async () => {
    const base = await setup();
    const table = await createDiningTable({ ...base, name: "B1", defaultSeats: 2, maxSeats: 2 });
    await setSpecialBusinessDate({ ...base, businessDate: "2032-01-01", kind: "SPECIAL_OPEN", reason: "신정 특별영업", periods: [{ opensAt: "17:00", closesAt: "21:00", closesDayOffset: 0 }] });
    await createReservationBlock({ ...base, tableId: table.id, startsAt: new Date("2032-01-01T09:00:00Z"), endsAt: new Date("2032-01-01T10:00:00Z"), reason: "정비" });
    const config = await getOperationsConfiguration(base);
    expect(config.specialDates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "SPECIAL_OPEN" })]));
    expect(config.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "정비" })]));
  });

  it("publishes an immutable policy and previews matching rules", async () => {
    const base = await setup();
    const draft = await createPolicyDraft({ ...base, name: "저녁 기본", rules: requiredRules });
    const preview = await previewPolicy({ ...base, policyId: draft.id, weekday: 5, localTime: "18:00", partySize: 4 });
    expect(preview.rules).toHaveLength(4);
    await publishPolicy({ ...base, policyId: draft.id, validFrom: "2035-01-01", validUntil: "2036-01-01" });
    await expect(pool.query("UPDATE reservation_policy_rules SET duration_minutes=120 WHERE policy_version_id=$1 AND rule_type='DURATION'", [draft.id]))
      .rejects.toMatchObject({ code: "55000" });
    const conflict = await createPolicyDraft({ ...base, name: "충돌", rules: requiredRules });
    await expect(publishPolicy({ ...base, policyId: conflict.id, validFrom: "2035-06-01", validUntil: "2036-06-01" }))
      .rejects.toMatchObject({ code: "POLICY_CONFLICT" });
  });

  it("requires all baseline policy rules", async () => {
    const base = await setup();
    await expect(createPolicyDraft({ ...base, name: "불완전", rules: requiredRules.slice(0, 3) }))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects staff configuration changes at the service boundary", async () => {
    const base = await setup("STAFF");
    await expect(createDiningTable({ ...base, name: "금지", defaultSeats: 2, maxSeats: 2 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
