import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { createDatabasePool, type DatabasePool } from "@reservation/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePaymentProvider } from "./provider";
import { createPaymentSession, expirePaymentIntents, getPaymentReconciliation, processPaymentWebhook, refundPayment } from "./service";

let pool: DatabasePool;
const restaurants: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(expiresAt = new Date(Date.now() + 30 * 60_000)) {
  const restaurantId = randomUUID(), reservationId = randomUUID(), token = randomUUID(); restaurants.push(restaurantId);
  await pool.query("INSERT INTO restaurants(id,name,timezone,currency) VALUES($1,'payments','Asia/Taipei','TWD')", [restaurantId]);
  await pool.query(`INSERT INTO reservations(id,restaurant_id,reservation_number,source,status,business_date,starts_at,ends_at,party_size,seat_count,chargeable_party_size,expires_at) VALUES($1,$2,$3,'WEB','PENDING_PAYMENT','2035-01-01','2035-01-01T10:00Z','2035-01-01T11:00Z',2,2,2,$4)`, [reservationId, restaurantId, `PAY-${randomUUID()}`, expiresAt]);
  await pool.query("INSERT INTO reservation_policy_snapshots(reservation_id,restaurant_id,revision,duration_minutes,cleanup_minutes,deposit_minor,currency,requires_approval,evaluation_input,evaluation_result) VALUES($1,$2,1,60,0,1000,'TWD',false,'{}','{}')", [reservationId, restaurantId]);
  await pool.query("INSERT INTO reservation_access_tokens(reservation_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [reservationId, hash(token)]);
  return { restaurantId, reservationId, token };
}

beforeAll(() => { pool = createDatabasePool(); });
afterAll(async () => {
  if (restaurants.length) {
    await pool.query("DELETE FROM outbox_events WHERE aggregate_id IN(SELECT id FROM reservations WHERE restaurant_id=ANY($1::uuid[]))", [restaurants]);
    await pool.query("DELETE FROM payment_refunds WHERE payment_intent_id IN(SELECT id FROM payment_intents WHERE reservation_id IN(SELECT id FROM reservations WHERE restaurant_id=ANY($1::uuid[])))", [restaurants]);
    await pool.query("DELETE FROM payment_webhook_events WHERE provider='fake'");
    await pool.query("DELETE FROM payment_intents WHERE reservation_id IN(SELECT id FROM reservations WHERE restaurant_id=ANY($1::uuid[]))", [restaurants]);
    await pool.query("DELETE FROM reservations WHERE restaurant_id=ANY($1::uuid[])", [restaurants]);
    await pool.query("DELETE FROM restaurants WHERE id=ANY($1::uuid[])", [restaurants]);
  }
  await pool.end();
});

describe("payments", () => {
  it("creates one session, verifies signed idempotent success, and caps cumulative refunds", async () => {
    const f = await fixture(), provider = new FakePaymentProvider("test-secret"), key = randomUUID();
    await expect(createPaymentSession({ pool, provider, reservationId: f.reservationId, managementToken: "wrong", idempotencyKey: key })).rejects.toThrow("not payable");
    const session = await createPaymentSession({ pool, provider, reservationId: f.reservationId, managementToken: f.token, idempotencyKey: key });
    expect((await createPaymentSession({ pool, provider, reservationId: f.reservationId, managementToken: f.token, idempotencyKey: key })).paymentId).toBe(session.paymentId);
    const body = JSON.stringify({ eventId: randomUUID(), paymentId: session.paymentId, status: "SUCCEEDED", amountMinor: 1000, currency: "TWD" });
    await expect(processPaymentWebhook({ pool, provider, body, signature: "forged" })).rejects.toThrow("signature");
    await expect(processPaymentWebhook({ pool, provider, body, signature: provider.sign(body) })).resolves.toMatchObject({ duplicate: false, status: "SUCCEEDED" });
    await expect(processPaymentWebhook({ pool, provider, body, signature: provider.sign(body) })).resolves.toEqual({ duplicate: true });
    expect((await pool.query<{ status: string }>("SELECT status FROM reservations WHERE id=$1", [f.reservationId])).rows[0]?.status).toBe("CONFIRMED");
    await refundPayment({ pool, provider, paymentIntentId: session.id, amountMinor: 400, reason: "partial", idempotencyKey: "refund-1" });
    expect((await refundPayment({ pool, provider, paymentIntentId: session.id, amountMinor: 400, reason: "partial", idempotencyKey: "refund-1" })).status).toBe("SUCCEEDED");
    await expect(refundPayment({ pool, provider, paymentIntentId: session.id, amountMinor: 601, reason: "too much", idempotencyKey: "refund-2" })).rejects.toThrow("exceeds");
    await refundPayment({ pool, provider, paymentIntentId: session.id, amountMinor: 600, reason: "remainder", idempotencyKey: "refund-3" });
    expect((await pool.query<{ status: string }>("SELECT status FROM payment_intents WHERE id=$1", [session.id])).rows[0]?.status).toBe("REFUNDED");
  });

  it("expires unpaid reservations and does not auto-confirm a late payment without a seat", async () => {
    const f = await fixture(new Date(Date.now() - 60_000)), provider = new FakePaymentProvider("late-secret");
    const session = await createPaymentSession({ pool, provider, reservationId: f.reservationId, managementToken: f.token, idempotencyKey: randomUUID() });
    await pool.query("UPDATE payment_intents SET expires_at=now()-interval '1 minute' WHERE id=$1", [session.id]);
    expect(await expirePaymentIntents(pool)).toBe(1);
    const body = JSON.stringify({ eventId: randomUUID(), paymentId: session.paymentId, status: "SUCCEEDED", amountMinor: 1000, currency: "TWD" });
    await processPaymentWebhook({ pool, provider, body, signature: provider.sign(body) });
    expect((await pool.query<{ status: string }>("SELECT status FROM reservations WHERE id=$1", [f.reservationId])).rows[0]?.status).toBe("EXPIRED");
    expect((await getPaymentReconciliation(pool)).payments).toEqual(expect.arrayContaining([expect.objectContaining({ reservation_id: f.reservationId, payment_status: "SUCCEEDED", reservation_status: "EXPIRED" })]));
  });
});
