import { createHash, randomUUID } from "node:crypto";
import type { DatabasePool } from "@reservation/db";
import type { PoolClient } from "pg";
import { ReservationError } from "./reservation-error";
import type { EvaluatedPolicy, HoldRequest } from "./types";

const HOLD_MINUTES = 10;
const MAX_ACTIVE_HOLDS = 3;

async function transaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

type Rule = { rule_type: string; priority: number; duration_minutes: number | null; amount_minor: string | null; value: Record<string, unknown> };
export function evaluatePolicy(policyVersionId: string, rules: Rule[]): EvaluatedPolicy {
  const first = (type: string) => rules.filter((rule) => rule.rule_type === type).sort((a, b) => b.priority - a.priority)[0];
  const duration = first("DURATION")?.duration_minutes;
  const interval = first("START_INTERVAL")?.duration_minutes;
  const booking = first("BOOKING_WINDOW")?.value;
  const party = first("PARTY_LIMIT");
  if (!duration || !interval || !booking || !party) throw new ReservationError("INVALID_REQUEST", "Policy is missing a baseline rule");
  const opensDaysAhead = Number(booking.opensDaysAhead);
  const cutoffMinutes = Number(booking.cutoffMinutes);
  if (!Number.isInteger(opensDaysAhead) || opensDaysAhead < 0 || !Number.isInteger(cutoffMinutes) || cutoffMinutes < 0) throw new ReservationError("INVALID_REQUEST", "Booking window is invalid");
  return {
    policyVersionId, durationMinutes: duration, cleanupMinutes: first("CLEANUP")?.duration_minutes ?? 0,
    startIntervalMinutes: interval, minimumSpendMinor: Number(first("MINIMUM_SPEND")?.amount_minor ?? 0),
    depositMinor: Number(first("DEPOSIT")?.amount_minor ?? 0), requiresApproval: first("APPROVAL")?.value.required === true,
    opensDaysAhead, cutoffMinutes,
  };
}

function localDateTime(instant: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23" }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour"))*60+Number(get("minute")) };
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.slice(0,5).split(":").map(Number) as [number,number]; return hour*60+minute;
}

async function validateOperatingPeriod(client: PoolClient, restaurantId: string, businessDate: string, startsAt: Date, occupiedUntil: Date): Promise<void> {
  const restaurant = await client.query<{ timezone: string }>("SELECT timezone FROM restaurants WHERE id=$1", [restaurantId]);
  const timezone = restaurant.rows[0]?.timezone; if (!timezone) throw new ReservationError("INVALID_REQUEST", "Restaurant was not found");
  const localStart = localDateTime(startsAt,timezone); const localEnd = localDateTime(occupiedUntil,timezone);
  const nextDate = new Date(`${businessDate}T00:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate()+1);
  const next = nextDate.toISOString().slice(0,10);
  if (localStart.date !== businessDate && localStart.date !== next) throw new ReservationError("INVALID_REQUEST", "Start time does not belong to the business date");
  const startMinute = localStart.minutes + (localStart.date === next ? 1440 : 0);
  const endMinute = localEnd.minutes + (localEnd.date === next ? 1440 : localEnd.date > next ? 2880 : 0);
  const special = await client.query<{ kind: string; opens_at: string | null; closes_at: string | null; closes_day_offset: number | null }>(
    `SELECT sd.kind,sp.opens_at::text,sp.closes_at::text,sp.closes_day_offset FROM special_business_dates sd LEFT JOIN special_business_periods sp ON sp.special_date_id=sd.id WHERE sd.restaurant_id=$1 AND sd.business_date=$2`, [restaurantId,businessDate],
  );
  if (special.rows[0]?.kind === "CLOSED") throw new ReservationError("NOT_AVAILABLE", "Restaurant is closed on this date");
  let periods = special.rows[0]?.kind === "SPECIAL_OPEN" ? special.rows : [];
  if (!periods.length) {
    const weekday = new Date(`${businessDate}T00:00:00Z`).getUTCDay();
    periods = (await client.query<{ kind: string; opens_at: string; closes_at: string; closes_day_offset: number }>("SELECT 'REGULAR' AS kind,opens_at::text,closes_at::text,closes_day_offset FROM business_hours WHERE restaurant_id=$1 AND weekday=$2 AND active=TRUE", [restaurantId,weekday])).rows;
  }
  const contained = periods.some((period) => period.opens_at && period.closes_at && startMinute >= timeMinutes(period.opens_at) && endMinute <= timeMinutes(period.closes_at)+(period.closes_day_offset ?? 0)*1440);
  if (!contained) throw new ReservationError("NOT_AVAILABLE", "Requested period is outside business hours");
}

async function loadPolicy(client: PoolClient, restaurantId: string, businessDate: string, partySize: number, startsAt: Date): Promise<EvaluatedPolicy> {
  const policy = await client.query<{ id: string; timezone: string }>(
    `SELECT pv.id,r.timezone FROM policy_schedules ps JOIN policy_versions pv ON pv.id=ps.policy_version_id
     JOIN restaurants r ON r.id=ps.restaurant_id
     WHERE ps.restaurant_id=$1 AND ps.valid_during @> $2::date AND pv.status='PUBLISHED'`, [restaurantId, businessDate],
  );
  const id = policy.rows[0]?.id; if (!id) throw new ReservationError("POLICY_NOT_FOUND", "No published policy applies to this date");
  const weekday = new Date(`${businessDate}T00:00:00Z`).getUTCDay();
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: policy.rows[0]?.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(startsAt);
  const rules = await client.query<Rule>(
    `SELECT rule_type,priority,duration_minutes,amount_minor,value FROM reservation_policy_rules
     WHERE policy_version_id=$1 AND (weekdays IS NULL OR $2=ANY(weekdays))
       AND (min_party_size IS NULL OR min_party_size <= $3) AND (max_party_size IS NULL OR max_party_size >= $3)
       AND (local_start IS NULL OR local_start <= $4::time) AND (local_end IS NULL OR local_end > $4::time)
     ORDER BY priority DESC`, [id, weekday, partySize, localTime],
  );
  return evaluatePolicy(id, rules.rows);
}

async function releaseExpired(client: PoolClient, now: Date): Promise<string[]> {
  const expired = await client.query<{ id: string }>(
    `UPDATE reservations SET status='EXPIRED',expires_at=NULL,version=version+1,updated_at=$1
     WHERE status='HOLD' AND expires_at <= $1 RETURNING id`, [now],
  );
  const ids = expired.rows.map((row) => row.id); if (!ids.length) return ids;
  await client.query("UPDATE reservation_allocations SET released_at=$2 WHERE reservation_id=ANY($1::uuid[]) AND released_at IS NULL", [ids, now]);
  await client.query(`INSERT INTO reservation_events (reservation_id,event_type,from_status,to_status,reservation_version)
    SELECT id,'HOLD_EXPIRED','HOLD','EXPIRED',version FROM reservations WHERE id=ANY($1::uuid[])`, [ids]);
  await client.query(`INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload,event_key)
    SELECT 'RESERVATION',id,'HOLD_EXPIRED',jsonb_build_object('reservationId',id),'hold-expired:'||id FROM reservations WHERE id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`, [ids]);
  return ids;
}

export async function expireHolds(pool: DatabasePool, now = new Date()): Promise<number> {
  return transaction(pool, async (client) => (await releaseExpired(client, now)).length);
}

function requestHash(input: HoldRequest): string {
  return createHash("sha256").update(JSON.stringify({ restaurantId: input.restaurantId, businessDate: input.businessDate, startsAt: input.startsAt.toISOString(), partySize: input.partySize, seatCount: input.seatCount ?? input.partySize })).digest("hex");
}

async function candidates(client: PoolClient, restaurantId: string, seats: number): Promise<string[][]> {
  const singles = await client.query<{ id: string; max_seats: number }>("SELECT id,max_seats FROM dining_tables WHERE restaurant_id=$1 AND inactive_at IS NULL AND max_seats >= $2 ORDER BY max_seats,id", [restaurantId, seats]);
  const combos = await client.query<{ table_ids: string[]; max_seats: number }>(
    `SELECT array_agg(tcm.table_id ORDER BY tcm.position) AS table_ids,tc.max_seats FROM table_combinations tc
     JOIN table_combination_members tcm ON tcm.combination_id=tc.id
     JOIN dining_tables dt ON dt.id=tcm.table_id AND dt.restaurant_id=tc.restaurant_id
     WHERE tc.restaurant_id=$1 AND tc.active=TRUE AND tc.max_seats >= $2
     GROUP BY tc.id HAVING bool_and(dt.inactive_at IS NULL) ORDER BY tc.max_seats,tc.id`, [restaurantId, seats],
  );
  return [...singles.rows.map((row) => [row.id]), ...combos.rows.map((row) => row.table_ids)];
}

export async function createHold(input: HoldRequest) {
  if (!input.ownerScope || !input.idempotencyKey || input.partySize < 1 || input.startsAt <= (input.now ?? new Date())) throw new ReservationError("INVALID_REQUEST", "Hold request is invalid");
  const now = input.now ?? new Date(); const hash = requestHash(input); const seats = input.seatCount ?? input.partySize;
  return transaction(input.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [input.restaurantId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [`${input.restaurantId}:${input.ownerScope}`]);
    await releaseExpired(client, now);
    const idem = await client.query<{ request_hash: string; response_body: { reservationId: string; expiresAt: string } | null }>(
      `INSERT INTO idempotency_requests (restaurant_id,actor_scope,operation,idempotency_key,request_hash,expires_at)
       VALUES ($1,$2,'CREATE_HOLD',$3,$4,$5) ON CONFLICT (restaurant_id,actor_scope,operation,idempotency_key)
       DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING request_hash,response_body`,
      [input.restaurantId, input.ownerScope, input.idempotencyKey, hash, new Date(now.getTime() + 86_400_000)],
    );
    const previous = idem.rows[0];
    if (previous?.request_hash !== hash) throw new ReservationError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with another request");
    if (previous.response_body) return previous.response_body;
    const active = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM reservations WHERE restaurant_id=$1 AND hold_owner_scope=$2 AND status='HOLD' AND expires_at>$3", [input.restaurantId, input.ownerScope, now]);
    if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_HOLDS) throw new ReservationError("RATE_LIMITED", "Too many active holds");
    const policy = await loadPolicy(client, input.restaurantId, input.businessDate, input.partySize, input.startsAt);
    const endsAt = new Date(input.startsAt.getTime() + policy.durationMinutes * 60_000);
    const occupiedUntil = new Date(endsAt.getTime() + policy.cleanupMinutes * 60_000);
    if (input.startsAt.getTime() - now.getTime() < policy.cutoffMinutes*60_000 || input.startsAt.getTime() - now.getTime() > policy.opensDaysAhead*86_400_000) throw new ReservationError("INVALID_REQUEST", "Requested time is outside the booking window");
    const restaurantZone = await client.query<{ timezone: string }>("SELECT timezone FROM restaurants WHERE id=$1", [input.restaurantId]);
    const localStart = localDateTime(input.startsAt,restaurantZone.rows[0]?.timezone ?? "UTC");
    if (localStart.minutes % policy.startIntervalMinutes !== 0) throw new ReservationError("INVALID_REQUEST", "Start time does not match the policy interval");
    await validateOperatingPeriod(client,input.restaurantId,input.businessDate,input.startsAt,occupiedUntil);
    const blocked = await client.query("SELECT 1 FROM reservation_blocks WHERE restaurant_id=$1 AND blocked_period && tstzrange($2,$3,'[)') AND table_id IS NULL LIMIT 1", [input.restaurantId, input.startsAt, occupiedUntil]);
    if (blocked.rowCount) throw new ReservationError("NOT_AVAILABLE", "Restaurant is blocked for this period");
    const reservationId = randomUUID(); const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
    await client.query(
      `INSERT INTO reservations (id,restaurant_id,reservation_number,source,status,business_date,starts_at,ends_at,party_size,seat_count,chargeable_party_size,expires_at,hold_owner_scope)
       VALUES ($1,$2,$3,'WEB','HOLD',$4,$5,$6,$7,$8,$7,$9,$10)`,
      [reservationId,input.restaurantId,`H-${reservationId.slice(0,8).toUpperCase()}`,input.businessDate,input.startsAt,endsAt,input.partySize,seats,expiresAt,input.ownerScope],
    );
    let allocated = false;
    for (const tableIds of await candidates(client, input.restaurantId, seats)) {
      await client.query("SAVEPOINT allocation_attempt");
      try {
        const tableBlocked = await client.query("SELECT 1 FROM reservation_blocks WHERE restaurant_id=$1 AND table_id=ANY($2::uuid[]) AND blocked_period && tstzrange($3,$4,'[)') LIMIT 1", [input.restaurantId, tableIds, input.startsAt, occupiedUntil]);
        if (tableBlocked.rowCount) throw new ReservationError("NOT_AVAILABLE", "Candidate is blocked");
        for (const tableId of tableIds) await client.query("INSERT INTO reservation_allocations (restaurant_id,reservation_id,table_id,occupied_period) VALUES ($1,$2,$3,tstzrange($4,$5,'[)'))", [input.restaurantId,reservationId,tableId,input.startsAt,occupiedUntil]);
        await client.query("RELEASE SAVEPOINT allocation_attempt"); allocated = true; break;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT allocation_attempt");
        if (!(error instanceof ReservationError) && !(typeof error === "object" && error && "code" in error && error.code === "23P01")) throw error;
      }
    }
    if (!allocated) throw new ReservationError("NOT_AVAILABLE", "No table is available");
    await client.query(
      `INSERT INTO reservation_policy_snapshots (reservation_id,restaurant_id,revision,policy_version_id,duration_minutes,cleanup_minutes,minimum_spend_minor,deposit_minor,currency,requires_approval,evaluation_input,evaluation_result)
       SELECT $1,$2,1,$3,$4,$5,$6,$7,r.currency,$8,$9,$10 FROM restaurants r WHERE r.id=$2`,
      [reservationId,input.restaurantId,policy.policyVersionId,policy.durationMinutes,policy.cleanupMinutes,policy.minimumSpendMinor,policy.depositMinor,policy.requiresApproval,JSON.stringify({ businessDate: input.businessDate, startsAt: input.startsAt, partySize: input.partySize }),JSON.stringify(policy)],
    );
    await client.query("INSERT INTO reservation_events (reservation_id,event_type,to_status,reservation_version) VALUES ($1,'HOLD_CREATED','HOLD',1)", [reservationId]);
    await client.query("INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload,event_key) VALUES ('RESERVATION',$1,'HOLD_CREATED',$2,$3)", [reservationId,JSON.stringify({ reservationId }),`hold-created:${reservationId}`]);
    await client.query("INSERT INTO jobs (job_type,payload,run_at) VALUES ('EXPIRE_HOLD',$1,$2)", [JSON.stringify({ reservationId }),expiresAt]);
    const response = { reservationId, expiresAt: expiresAt.toISOString() };
    await client.query("UPDATE idempotency_requests SET response_status=201,response_body=$5 WHERE restaurant_id=$1 AND actor_scope=$2 AND operation='CREATE_HOLD' AND idempotency_key=$3 AND request_hash=$4", [input.restaurantId,input.ownerScope,input.idempotencyKey,hash,JSON.stringify(response)]);
    return response;
  });
}

export async function submitHold(input: { pool: DatabasePool; reservationId: string; ownerScope: string; expectedVersion: number; now?: Date }) {
  const now = input.now ?? new Date();
  return transaction(input.pool, async (client) => {
    await releaseExpired(client, now);
    const row = await client.query<{ status: string; version: number; expires_at: Date | null; requires_approval: boolean; deposit_minor: string }>(
      `SELECT r.status,r.version,r.expires_at,s.requires_approval,s.deposit_minor FROM reservations r
       JOIN reservation_policy_snapshots s ON s.reservation_id=r.id AND s.revision=1
       WHERE r.id=$1 AND r.hold_owner_scope=$2 FOR UPDATE OF r`, [input.reservationId,input.ownerScope],
    );
    const reservation = row.rows[0]; if (!reservation) throw new ReservationError("FORBIDDEN", "Hold does not belong to this session");
    if (reservation.status !== "HOLD" || !reservation.expires_at || reservation.expires_at <= now) throw new ReservationError("HOLD_EXPIRED", "Hold has expired");
    if (reservation.version !== input.expectedVersion) throw new ReservationError("VERSION_CONFLICT", "Reservation version changed");
    const status = Number(reservation.deposit_minor) > 0 ? "PENDING_PAYMENT" : reservation.requires_approval ? "PENDING_APPROVAL" : "CONFIRMED";
    const expiresAt = status === "PENDING_PAYMENT" ? new Date(now.getTime() + 30 * 60_000) : null;
    await client.query("UPDATE reservations SET status=$2,expires_at=$3,submitted_at=$4,version=version+1,updated_at=$4 WHERE id=$1", [input.reservationId,status,expiresAt,now]);
    await client.query("INSERT INTO reservation_events (reservation_id,event_type,from_status,to_status,reservation_version) VALUES ($1,'HOLD_SUBMITTED','HOLD',$2,$3)", [input.reservationId,status,reservation.version+1]);
    await client.query("INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload,event_key) VALUES ('RESERVATION',$1,'HOLD_SUBMITTED',$2,$3)", [input.reservationId,JSON.stringify({ reservationId: input.reservationId, status }),`hold-submitted:${input.reservationId}`]);
    return { reservationId: input.reservationId, status, version: reservation.version + 1, expiresAt: expiresAt?.toISOString() ?? null };
  });
}

export async function getAvailability(input: { pool: DatabasePool; restaurantId: string; businessDate: string; startsAt: Date; partySize: number; now?: Date }) {
  const now = input.now ?? new Date();
  await expireHolds(input.pool,now);
  const client = await input.pool.connect();
  try {
    const policy = await loadPolicy(client, input.restaurantId, input.businessDate, input.partySize, input.startsAt);
    const until = new Date(input.startsAt.getTime() + (policy.durationMinutes + policy.cleanupMinutes) * 60_000);
    if (input.startsAt.getTime()-now.getTime()<policy.cutoffMinutes*60_000 || input.startsAt.getTime()-now.getTime()>policy.opensDaysAhead*86_400_000) throw new ReservationError("INVALID_REQUEST","Requested time is outside the booking window");
    const zone = await client.query<{ timezone:string }>("SELECT timezone FROM restaurants WHERE id=$1",[input.restaurantId]);
    if (localDateTime(input.startsAt,zone.rows[0]?.timezone ?? "UTC").minutes%policy.startIntervalMinutes!==0) throw new ReservationError("INVALID_REQUEST","Start time does not match the policy interval");
    await validateOperatingPeriod(client,input.restaurantId,input.businessDate,input.startsAt,until);
    let available = false;
    for (const tableIds of await candidates(client,input.restaurantId,input.partySize)) {
      const conflicts = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM reservation_allocations a WHERE a.restaurant_id=$1 AND a.table_id=ANY($2::uuid[]) AND a.released_at IS NULL AND a.occupied_period && tstzrange($3,$4,'[)'))
         OR EXISTS (SELECT 1 FROM reservation_blocks b WHERE b.restaurant_id=$1 AND (b.table_id IS NULL OR b.table_id=ANY($2::uuid[])) AND b.blocked_period && tstzrange($3,$4,'[)'))`,
        [input.restaurantId,tableIds,input.startsAt,until],
      );
      if (!conflicts.rowCount) { available=true; break; }
    }
    return { available, policy, startsAt: input.startsAt.toISOString(), endsAt: new Date(input.startsAt.getTime()+policy.durationMinutes*60_000).toISOString() };
  } finally { client.release(); }
}

export async function processDueJobs(pool: DatabasePool, workerId: string, now = new Date()): Promise<number> {
  return transaction(pool, async (client) => {
    const claimed = await client.query<{ id: string; job_type: string; payload: { reservationId?: string } }>(
      `WITH claim AS (SELECT id FROM jobs WHERE run_at <= $1 AND (status='PENDING' OR (status='RUNNING' AND lease_until <= $1)) ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 20)
       UPDATE jobs j SET status='RUNNING',locked_by=$2,lease_until=$3,attempts=attempts+1,updated_at=$1 FROM claim WHERE j.id=claim.id RETURNING j.id,j.job_type,j.payload`,
      [now,workerId,new Date(now.getTime()+30_000)],
    );
    for (const job of claimed.rows) {
      await client.query("SAVEPOINT process_job");
      try {
        if (job.job_type === "EXPIRE_HOLD") await releaseExpired(client, now);
        await client.query("UPDATE jobs SET status='SUCCEEDED',lease_until=NULL,completed_at=$2,updated_at=$2 WHERE id=$1", [job.id,now]);
        await client.query("RELEASE SAVEPOINT process_job");
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0,500) : "unknown";
        await client.query("ROLLBACK TO SAVEPOINT process_job");
        await client.query("UPDATE jobs SET status='FAILED',lease_until=NULL,last_error=$2,run_at=$3,updated_at=$4 WHERE id=$1", [job.id,message,new Date(now.getTime()+60_000),now]);
      }
    }
    return claimed.rowCount ?? 0;
  });
}
