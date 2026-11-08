import { createHash } from "node:crypto";
import type { DatabasePool } from "@reservation/db";
import type { PaymentProvider } from "./provider";

const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createPaymentSession(input: { pool: DatabasePool; provider: PaymentProvider; reservationId: string; managementToken: string; idempotencyKey: string }) {
  if (!input.idempotencyKey.trim()) throw new Error("idempotency key is required");
  const old = await input.pool.query<{ id: string; provider_payment_id: string; checkout_url: string; expires_at: Date }>("SELECT id,provider_payment_id,checkout_url,expires_at FROM payment_intents WHERE provider=$1 AND idempotency_key=$2", [input.provider.name, input.idempotencyKey]);
  if (old.rows[0]) return { id: old.rows[0].id, paymentId: old.rows[0].provider_payment_id, checkoutUrl: old.rows[0].checkout_url, expiresAt: old.rows[0].expires_at };
  const payable = await input.pool.query<{ deposit_minor: string; currency: string; status: string }>(`SELECT s.deposit_minor,s.currency,r.status FROM reservations r JOIN reservation_access_tokens t ON t.reservation_id=r.id JOIN reservation_policy_snapshots s ON s.reservation_id=r.id AND s.revision=1 WHERE r.id=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND t.expires_at>now()`, [input.reservationId, tokenHash(input.managementToken)]);
  const reservation = payable.rows[0];
  if (!reservation || reservation.status !== "PENDING_PAYMENT" || Number(reservation.deposit_minor) <= 0) throw new Error("reservation is not payable");
  const session = await input.provider.createSession({ amountMinor: Number(reservation.deposit_minor), currency: reservation.currency, idempotencyKey: input.idempotencyKey });
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string }>("SELECT status FROM reservations WHERE id=$1 FOR UPDATE", [input.reservationId]);
    if (locked.rows[0]?.status !== "PENDING_PAYMENT") throw new Error("reservation is not payable");
    const result = await client.query<{ id: string; provider_payment_id: string; checkout_url: string; expires_at: Date }>(`INSERT INTO payment_intents(reservation_id,provider,provider_payment_id,idempotency_key,amount_minor,currency,status,checkout_url,expires_at) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8) ON CONFLICT(provider,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,provider_payment_id,checkout_url,expires_at`, [input.reservationId, input.provider.name, session.paymentId, input.idempotencyKey, reservation.deposit_minor, reservation.currency, session.checkoutUrl, session.expiresAt]);
    await client.query("COMMIT");
    const row = result.rows[0]!;
    return { id: row.id, paymentId: row.provider_payment_id, checkoutUrl: row.checkout_url, expiresAt: row.expires_at };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function processPaymentWebhook(input: { pool: DatabasePool; provider: PaymentProvider; body: string; signature: string }) {
  const event = input.provider.parseWebhook(input.body, input.signature);
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>("INSERT INTO payment_webhook_events(provider,provider_event_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id", [input.provider.name, event.eventId, input.body]);
    if (!inserted.rows[0]) { await client.query("COMMIT"); return { duplicate: true as const }; }
    const payment = await client.query<{ id: string; reservation_id: string; amount_minor: string; currency: string; status: string }>("SELECT id,reservation_id,amount_minor,currency,status FROM payment_intents WHERE provider=$1 AND provider_payment_id=$2 FOR UPDATE", [input.provider.name, event.paymentId]);
    const row = payment.rows[0];
    if (!row) throw new Error("payment not found");
    if (Number(row.amount_minor) !== event.amountMinor || row.currency !== event.currency) throw new Error("payment amount or currency mismatch");
    if (row.status === "SUCCEEDED" && event.status !== "SUCCEEDED") {
      await client.query("UPDATE payment_webhook_events SET processed_at=now() WHERE id=$1", [inserted.rows[0].id]); await client.query("COMMIT"); return { duplicate: false as const, status: row.status };
    }
    await client.query("UPDATE payment_intents SET status=$2,paid_at=CASE WHEN $2='SUCCEEDED' THEN now() ELSE paid_at END,updated_at=now() WHERE id=$1", [row.id, event.status]);
    if (event.status === "SUCCEEDED") {
      const reservation = await client.query<{ requires_approval: boolean }>("SELECT s.requires_approval FROM reservations r JOIN reservation_policy_snapshots s ON s.reservation_id=r.id AND s.revision=1 WHERE r.id=$1 FOR UPDATE OF r", [row.reservation_id]);
      const next = reservation.rows[0]?.requires_approval ? "PENDING_APPROVAL" : "CONFIRMED";
      const changed = await client.query("UPDATE reservations SET status=$2,expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status='PENDING_PAYMENT'", [row.reservation_id, next]);
      if (changed.rowCount) await client.query("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,event_key) VALUES('RESERVATION',$1,'PAYMENT_SUCCEEDED',$2,$3) ON CONFLICT DO NOTHING", [row.reservation_id, JSON.stringify({ paymentIntentId: row.id }), `payment-succeeded:${row.id}`]);
    }
    await client.query("UPDATE payment_webhook_events SET processed_at=now() WHERE id=$1", [inserted.rows[0].id]);
    await client.query("COMMIT");
    return { duplicate: false as const, status: event.status };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function refundPayment(input: { pool: DatabasePool; provider: PaymentProvider; paymentIntentId: string; amountMinor: number; reason: string; idempotencyKey: string }) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("refund amount must be a positive integer");
  const old = await input.pool.query<{ provider_refund_id: string; status: "SUCCEEDED" | "UNKNOWN" }>("SELECT provider_refund_id,status FROM payment_refunds WHERE payment_intent_id=$1 AND idempotency_key=$2", [input.paymentIntentId, input.idempotencyKey]);
  if (old.rows[0]) return { refundId: old.rows[0].provider_refund_id, status: old.rows[0].status };
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await client.query<{ provider_payment_id: string; amount_minor: string }>("SELECT provider_payment_id,amount_minor FROM payment_intents WHERE id=$1 AND status IN('SUCCEEDED','PARTIALLY_REFUNDED') FOR UPDATE", [input.paymentIntentId]);
    const row = payment.rows[0];
    const refunded = row ? await client.query<{ amount: string }>("SELECT COALESCE(sum(amount_minor) FILTER(WHERE status='SUCCEEDED'),0)::text amount FROM payment_refunds WHERE payment_intent_id=$1", [input.paymentIntentId]) : null;
    const refundedAmount = Number(refunded?.rows[0]?.amount ?? 0);
    if (!row || refundedAmount + input.amountMinor > Number(row.amount_minor)) throw new Error("refund exceeds paid amount");
    const result = await input.provider.refund({ paymentId: row.provider_payment_id, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    await client.query("INSERT INTO payment_refunds(payment_intent_id,provider_refund_id,idempotency_key,amount_minor,reason,status,completed_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='SUCCEEDED' THEN now() END)", [input.paymentIntentId, result.refundId, input.idempotencyKey, input.amountMinor, input.reason, result.status]);
    if (result.status === "SUCCEEDED") { const total = refundedAmount + input.amountMinor; await client.query("UPDATE payment_intents SET status=$2,updated_at=now() WHERE id=$1", [input.paymentIntentId, total === Number(row.amount_minor) ? "REFUNDED" : "PARTIALLY_REFUNDED"]); }
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function expirePaymentIntents(pool: DatabasePool, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string; reservation_id: string }>(`UPDATE payment_intents SET status='EXPIRED',updated_at=$1 WHERE id IN (SELECT id FROM payment_intents WHERE status='PENDING' AND expires_at<=$1 FOR UPDATE SKIP LOCKED) RETURNING id,reservation_id`, [now]);
    for (const row of expired.rows) { const changed = await client.query("UPDATE reservations SET status='EXPIRED',expires_at=NULL,version=version+1,updated_at=$2 WHERE id=$1 AND status='PENDING_PAYMENT'", [row.reservation_id, now]); if (changed.rowCount) await client.query("UPDATE reservation_allocations SET released_at=$2 WHERE reservation_id=$1 AND released_at IS NULL", [row.reservation_id, now]); }
    await client.query("COMMIT"); return expired.rowCount ?? 0;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function getPaymentReconciliation(pool: DatabasePool) {
  const payments = await pool.query<{ payment_intent_id: string; reservation_id: string; payment_status: string; reservation_status: string; amount_minor: string; currency: string }>(
    `SELECT p.id payment_intent_id,p.reservation_id,p.status payment_status,r.status reservation_status,p.amount_minor::text,p.currency
     FROM payment_intents p JOIN reservations r ON r.id=p.reservation_id
     WHERE (p.status='SUCCEEDED' AND r.status NOT IN('CONFIRMED','PENDING_APPROVAL','SEATED','COMPLETED'))
        OR p.status='UNKNOWN' ORDER BY p.updated_at`,
  );
  const refunds = await pool.query<{ refund_id: string; payment_intent_id: string; status: string; amount_minor: string }>("SELECT id refund_id,payment_intent_id,status,amount_minor::text FROM payment_refunds WHERE status IN('PENDING','UNKNOWN','FAILED') ORDER BY created_at");
  return { payments: payments.rows, refunds: refunds.rows };
}
