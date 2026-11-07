import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createDatabasePool, type DatabasePool } from "@reservation/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHold, expireHolds, getAvailability, processDueJobs, submitHold } from "./service";

let pool: DatabasePool;
const restaurantIds: string[] = [];
const future = new Date("2035-06-10T10:00:00.000Z");
const now = new Date("2035-06-01T00:00:00.000Z");

async function fixture(tableCapacities = [4], policyOptions: { approval?: boolean; depositMinor?: number } = {}) {
  const restaurantId = randomUUID(); const policyId = randomUUID(); restaurantIds.push(restaurantId);
  await pool.query("INSERT INTO restaurants (id,name,timezone,currency) VALUES ($1,$2,'Asia/Taipei','TWD')", [restaurantId, `engine-${restaurantId}`]);
  const tableIds: string[] = [];
  for (const [index, capacity] of tableCapacities.entries()) {
    const id = randomUUID(); tableIds.push(id);
    await pool.query("INSERT INTO dining_tables (id,restaurant_id,name,default_seats,max_seats) VALUES ($1,$2,$3,$4,$4)", [id,restaurantId,`T${index+1}`,capacity]);
  }
  const weekday = new Date("2035-06-10T00:00:00Z").getUTCDay();
  await pool.query("INSERT INTO business_hours (restaurant_id,weekday,opens_at,closes_at,closes_day_offset) VALUES ($1,$2,'00:00','23:59',0)", [restaurantId,weekday]);
  await pool.query("INSERT INTO policy_versions (id,restaurant_id,version,status,name) VALUES ($1,$2,1,'DRAFT','엔진 테스트')", [policyId,restaurantId]);
  await pool.query(
    `INSERT INTO reservation_policy_rules (policy_version_id,rule_type,duration_minutes,value) VALUES
     ($1,'DURATION',90,'{}'),($1,'CLEANUP',15,'{}'),($1,'START_INTERVAL',15,'{}'),
     ($1,'BOOKING_WINDOW',NULL,'{"opensDaysAhead":3650,"cutoffMinutes":0}'),($1,'PARTY_LIMIT',NULL,'{}')`, [policyId],
  );
  await pool.query("UPDATE reservation_policy_rules SET min_party_size=1,max_party_size=20 WHERE policy_version_id=$1 AND rule_type='PARTY_LIMIT'", [policyId]);
  if (policyOptions.approval) await pool.query("INSERT INTO reservation_policy_rules (policy_version_id,rule_type,value) VALUES ($1,'APPROVAL','{\"required\":true}')",[policyId]);
  if (policyOptions.depositMinor) await pool.query("INSERT INTO reservation_policy_rules (policy_version_id,rule_type,amount_minor,value) VALUES ($1,'DEPOSIT',$2,'{}')",[policyId,policyOptions.depositMinor]);
  await pool.query("UPDATE policy_versions SET status='PUBLISHED',published_at=$2 WHERE id=$1", [policyId,now]);
  await pool.query("INSERT INTO policy_schedules (restaurant_id,policy_version_id,valid_during) VALUES ($1,$2,daterange('2035-01-01','2036-01-01','[)'))", [restaurantId,policyId]);
  return { restaurantId, tableIds, policyId };
}

function hold(restaurantId: string, overrides: Partial<{ ownerScope: string; idempotencyKey: string; startsAt: Date; partySize: number }> = {}) {
  return createHold({ pool, restaurantId, ownerScope: overrides.ownerScope ?? randomUUID(), idempotencyKey: overrides.idempotencyKey ?? randomUUID(), businessDate: "2035-06-10", startsAt: overrides.startsAt ?? future, partySize: overrides.partySize ?? 4, now });
}

beforeAll(() => { pool = createDatabasePool(); });
afterAll(async () => {
  if (restaurantIds.length) {
    const reservations = await pool.query<{ id: string }>("SELECT id FROM reservations WHERE restaurant_id=ANY($1::uuid[])", [restaurantIds]);
    const ids = reservations.rows.map((row) => row.id);
    if (ids.length) {
      await pool.query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM jobs WHERE payload->>'reservationId'=ANY($1::text[])", [ids]);
    }
    await pool.query("DELETE FROM reservations WHERE restaurant_id=ANY($1::uuid[])", [restaurantIds]);
    await pool.query("DELETE FROM restaurants WHERE id=ANY($1::uuid[])", [restaurantIds]);
  }
  await pool.end();
});

describe("reservation engine", () => {
  it("reports availability from policy, blocks, and live allocations", async () => {
    const {restaurantId}=await fixture([4]);
    await expect(getAvailability({pool,restaurantId,businessDate:"2035-06-10",startsAt:future,partySize:4,now})).resolves.toMatchObject({available:true,policy:{durationMinutes:90,cleanupMinutes:15}});
    await hold(restaurantId);
    await expect(getAvailability({pool,restaurantId,businessDate:"2035-06-10",startsAt:future,partySize:4,now})).resolves.toMatchObject({available:false});
  });

  it("allows exactly one of twenty concurrent holds for the final table", async () => {
    const { restaurantId } = await fixture([4]);
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => hold(restaurantId)));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected" && result.reason?.code === "NOT_AVAILABLE")).toHaveLength(19);
  });

  it("does not allow a combination and one of its members to win together", async () => {
    const { restaurantId, tableIds } = await fixture([4,4]);
    const combinationId = randomUUID();
    await pool.query("INSERT INTO table_combinations (id,restaurant_id,name,max_seats) VALUES ($1,$2,'T1+T2',8)", [combinationId,restaurantId]);
    await pool.query("INSERT INTO table_combination_members (combination_id,table_id,restaurant_id,position) VALUES ($1,$2,$4,1),($1,$3,$4,2)", [combinationId,tableIds[0],tableIds[1],restaurantId]);
    const attempts = await Promise.allSettled([hold(restaurantId,{ partySize: 8 }),hold(restaurantId,{ partySize: 4 })]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("honors cleanup time and permits the exact occupied boundary", async () => {
    const { restaurantId } = await fixture([4]);
    await hold(restaurantId);
    await expect(hold(restaurantId,{ startsAt: new Date("2035-06-10T11:30:00.000Z") })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(hold(restaurantId,{ startsAt: new Date("2035-06-10T11:45:00.000Z") })).resolves.toBeDefined();
  });

  it("returns the same hold for an idempotent retry and rejects another payload", async () => {
    const { restaurantId } = await fixture([4]); const ownerScope = randomUUID(); const idempotencyKey = randomUUID();
    const first = await hold(restaurantId,{ ownerScope,idempotencyKey });
    await expect(hold(restaurantId,{ ownerScope,idempotencyKey })).resolves.toEqual(first);
    await expect(hold(restaurantId,{ ownerScope,idempotencyKey,partySize:3 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("submits the same reservation id and emits a confirmed transition", async () => {
    const { restaurantId } = await fixture([4]); const ownerScope = randomUUID();
    const created = await hold(restaurantId,{ ownerScope });
    const submitted = await submitHold({ pool,reservationId:created.reservationId,ownerScope,expectedVersion:1,now:new Date(now.getTime()+60_000) });
    expect(submitted).toMatchObject({ reservationId:created.reservationId,status:"CONFIRMED",version:2 });
    const outbox = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_id=$1", [created.reservationId]);
    expect(Number(outbox.rows[0]?.count)).toBe(2);
  });

  it("does not confirm reservations that still require approval or payment", async () => {
    const approvalFixture=await fixture([4],{approval:true}); const approvalOwner=randomUUID();
    const approvalHold=await hold(approvalFixture.restaurantId,{ownerScope:approvalOwner});
    await expect(submitHold({pool,reservationId:approvalHold.reservationId,ownerScope:approvalOwner,expectedVersion:1,now:new Date(now.getTime()+60_000)})).resolves.toMatchObject({status:"PENDING_APPROVAL"});
    const paymentFixture=await fixture([4],{depositMinor:1000}); const paymentOwner=randomUUID();
    const paymentHold=await hold(paymentFixture.restaurantId,{ownerScope:paymentOwner});
    await expect(submitHold({pool,reservationId:paymentHold.reservationId,ownerScope:paymentOwner,expectedVersion:1,now:new Date(now.getTime()+60_000)})).resolves.toMatchObject({status:"PENDING_PAYMENT"});
  });

  it("limits one guest session to three simultaneous holds", async () => {
    const {restaurantId}=await fixture([4,4,4,4]); const ownerScope=randomUUID();
    await hold(restaurantId,{ownerScope}); await hold(restaurantId,{ownerScope}); await hold(restaurantId,{ownerScope});
    await expect(hold(restaurantId,{ownerScope})).rejects.toMatchObject({code:"RATE_LIMITED"});
  });

  it("expires holds, releases allocations, and refuses resubmission", async () => {
    const { restaurantId } = await fixture([4]); const ownerScope=randomUUID();
    const created=await hold(restaurantId,{ownerScope}); const afterExpiry=new Date(new Date(created.expiresAt).getTime()+1);
    expect(await expireHolds(pool,afterExpiry)).toBeGreaterThanOrEqual(1);
    await expect(submitHold({pool,reservationId:created.reservationId,ownerScope,expectedVersion:1,now:afterExpiry})).rejects.toMatchObject({code:"HOLD_EXPIRED"});
    await expect(hold(restaurantId,{startsAt:future,ownerScope:randomUUID()})).resolves.toBeDefined();
  });

  it("claims due expiry jobs once with a worker lease", async () => {
    const { restaurantId }=await fixture([4]); await hold(restaurantId);
    const processed=await processDueJobs(pool,"test-worker",new Date(now.getTime()+11*60_000));
    expect(processed).toBeGreaterThanOrEqual(1);
    const rerun=await processDueJobs(pool,"other-worker",new Date(now.getTime()+11*60_000));
    expect(rerun).toBe(0);
  });
});
