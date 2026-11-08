CREATE TABLE payment_intents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
 provider TEXT NOT NULL, provider_payment_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0), currency CHAR(3) NOT NULL,
 status TEXT NOT NULL CHECK(status IN('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','UNKNOWN')),
 checkout_url TEXT, paid_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(provider,provider_payment_id),UNIQUE(provider,idempotency_key)
);
CREATE TABLE payment_webhook_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),provider TEXT NOT NULL,provider_event_id TEXT NOT NULL,payload JSONB NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,processed_at TIMESTAMPTZ,error TEXT,UNIQUE(provider,provider_event_id)
);
CREATE TABLE payment_refunds (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
 provider_refund_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,amount_minor BIGINT NOT NULL CHECK(amount_minor>0),reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('PENDING','SUCCEEDED','FAILED','UNKNOWN')),created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at TIMESTAMPTZ,UNIQUE(payment_intent_id,provider_refund_id),UNIQUE(payment_intent_id,idempotency_key)
);
