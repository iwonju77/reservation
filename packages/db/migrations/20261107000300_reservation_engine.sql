ALTER TABLE reservations
    ADD COLUMN hold_owner_scope TEXT,
    ADD COLUMN submitted_at TIMESTAMPTZ,
    ADD CONSTRAINT reservations_hold_owner_check CHECK (
        status <> 'HOLD' OR (hold_owner_scope IS NOT NULL AND expires_at IS NOT NULL)
    );
CREATE INDEX reservations_active_holds_owner
    ON reservations (restaurant_id, hold_owner_scope, expires_at) WHERE status = 'HOLD';

ALTER TABLE jobs
    ADD COLUMN locked_by TEXT,
    ADD COLUMN completed_at TIMESTAMPTZ;

ALTER TABLE outbox_events ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX outbox_events_event_key_unique
    ON outbox_events (event_key) WHERE event_key IS NOT NULL;
