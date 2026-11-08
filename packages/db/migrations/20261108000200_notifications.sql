ALTER TABLE outbox_events ADD COLUMN locked_by TEXT, ADD COLUMN lease_until TIMESTAMPTZ;

CREATE TABLE notification_templates (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL, locale TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), body TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(restaurant_id,event_type,locale,version)
);
CREATE UNIQUE INDEX notification_templates_one_active ON notification_templates(restaurant_id,event_type,locale) WHERE active;

CREATE TABLE notification_deliveries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
 reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE, outbox_event_id UUID NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN('SMS')), recipient TEXT NOT NULL, locale TEXT NOT NULL,
 template_version INTEGER NOT NULL, provider TEXT NOT NULL, provider_message_id TEXT,
 status TEXT NOT NULL CHECK(status IN('PENDING','SENDING','SENT','DELIVERED','FAILED','UNKNOWN')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TIMESTAMPTZ,
 sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(outbox_event_id,channel)
);
CREATE INDEX notification_deliveries_retry ON notification_deliveries(next_attempt_at) WHERE status IN('FAILED','UNKNOWN');
