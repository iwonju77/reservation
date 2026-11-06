CREATE TABLE restaurants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    timezone TEXT NOT NULL CHECK (length(btrim(timezone)) > 0),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    default_locale TEXT NOT NULL DEFAULT 'zh-TW',
    online_booking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    waitlist_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    voice_ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, timezone),
    UNIQUE (id, currency)
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

CREATE TABLE restaurant_members (
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('STAFF', 'MANAGER', 'SYSTEM_ADMIN')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (restaurant_id, user_id)
);

CREATE TABLE dining_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    default_seats INTEGER NOT NULL CHECK (default_seats > 0),
    max_seats INTEGER NOT NULL CHECK (max_seats >= default_seats),
    zone TEXT,
    notes TEXT,
    active_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    inactive_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (inactive_at IS NULL OR inactive_at > active_from),
    UNIQUE (restaurant_id, name),
    UNIQUE (id, restaurant_id)
);

CREATE TABLE table_combinations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
    max_seats INTEGER NOT NULL CHECK (max_seats > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurant_id, name),
    UNIQUE (id, restaurant_id)
);

CREATE TABLE table_combination_members (
    combination_id UUID NOT NULL,
    table_id UUID NOT NULL,
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position > 0),
    PRIMARY KEY (combination_id, table_id),
    UNIQUE (combination_id, position),
    FOREIGN KEY (combination_id, restaurant_id)
        REFERENCES table_combinations(id, restaurant_id) ON DELETE CASCADE,
    FOREIGN KEY (table_id, restaurant_id)
        REFERENCES dining_tables(id, restaurant_id) ON DELETE CASCADE
);

CREATE TABLE business_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    opens_at TIME NOT NULL,
    closes_at TIME NOT NULL,
    closes_day_offset SMALLINT NOT NULL DEFAULT 0 CHECK (closes_day_offset IN (0, 1)),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK (
        (closes_day_offset = 0 AND closes_at > opens_at)
        OR (closes_day_offset = 1 AND closes_at <= opens_at)
    ),
    UNIQUE (restaurant_id, weekday, opens_at)
);

CREATE TABLE special_business_dates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    business_date DATE NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('CLOSED', 'SPECIAL_OPEN')), 
    reason TEXT,
    UNIQUE (restaurant_id, business_date),
    UNIQUE (id, restaurant_id)
);

CREATE TABLE special_business_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    special_date_id UUID NOT NULL,
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    opens_at TIME NOT NULL,
    closes_at TIME NOT NULL,
    closes_day_offset SMALLINT NOT NULL DEFAULT 0 CHECK (closes_day_offset IN (0, 1)),
    CHECK (
        (closes_day_offset = 0 AND closes_at > opens_at)
        OR (closes_day_offset = 1 AND closes_at <= opens_at)
    ),
    UNIQUE (special_date_id, opens_at),
    FOREIGN KEY (special_date_id, restaurant_id)
        REFERENCES special_business_dates(id, restaurant_id) ON DELETE CASCADE
);

CREATE TABLE reservation_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    table_id UUID,
    blocked_period TSTZRANGE NOT NULL,
    reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT isempty(blocked_period)),
    FOREIGN KEY (table_id, restaurant_id)
        REFERENCES dining_tables(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX reservation_blocks_period_gist ON reservation_blocks USING gist
    (restaurant_id, blocked_period);

CREATE TABLE policy_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
    published_by UUID REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
    UNIQUE (restaurant_id, version),
    UNIQUE (id, restaurant_id)
);

CREATE TABLE policy_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    policy_version_id UUID NOT NULL,
    valid_during DATERANGE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT isempty(valid_during)),
    FOREIGN KEY (policy_version_id, restaurant_id)
        REFERENCES policy_versions(id, restaurant_id) ON DELETE RESTRICT,
    EXCLUDE USING gist (restaurant_id WITH =, valid_during WITH &&)
);

CREATE TABLE reservation_policy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_version_id UUID NOT NULL REFERENCES policy_versions(id) ON DELETE CASCADE,
    rule_type TEXT NOT NULL CHECK (rule_type IN (
        'BOOKING_WINDOW', 'PARTY_LIMIT', 'DURATION', 'CLEANUP',
        'APPROVAL', 'MINIMUM_SPEND', 'DEPOSIT', 'CANCELLATION', 'NO_SHOW'
    )),
    priority INTEGER NOT NULL DEFAULT 0,
    weekdays SMALLINT[],
    local_start TIME,
    local_end TIME,
    min_party_size INTEGER CHECK (min_party_size IS NULL OR min_party_size > 0),
    max_party_size INTEGER CHECK (max_party_size IS NULL OR max_party_size > 0),
    duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK (max_party_size IS NULL OR min_party_size IS NULL OR max_party_size >= min_party_size),
    CHECK (weekdays IS NULL OR weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
);
CREATE INDEX reservation_policy_rules_lookup
    ON reservation_policy_rules (policy_version_id, rule_type, priority DESC);

CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    reservation_number TEXT NOT NULL CHECK (length(btrim(reservation_number)) >= 6),
    source TEXT NOT NULL CHECK (source IN ('WEB', 'PHONE_AI', 'STAFF', 'WALK_IN', 'WAITLIST')),
    status TEXT NOT NULL CHECK (status IN (
        'HOLD', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED',
        'SEATED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW'
    )),
    business_date DATE NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    party_size INTEGER NOT NULL CHECK (party_size > 0),
    seat_count INTEGER NOT NULL CHECK (seat_count > 0 AND seat_count <= party_size),
    chargeable_party_size INTEGER NOT NULL CHECK (
        chargeable_party_size >= 0 AND chargeable_party_size <= party_size
    ),
    customer_name TEXT CHECK (customer_name IS NULL OR length(btrim(customer_name)) > 0),
    customer_phone TEXT,
    customer_locale TEXT,
    expires_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (ends_at > starts_at),
    CHECK ((status IN ('HOLD', 'PENDING_APPROVAL', 'PENDING_PAYMENT')) OR expires_at IS NULL),
    UNIQUE (restaurant_id, reservation_number),
    UNIQUE (id, restaurant_id)
);
CREATE INDEX reservations_schedule_lookup
    ON reservations (restaurant_id, business_date, starts_at, status);

CREATE TABLE reservation_policy_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    policy_version_id UUID,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    cleanup_minutes INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_minutes >= 0),
    minimum_spend_minor BIGINT NOT NULL DEFAULT 0 CHECK (minimum_spend_minor >= 0),
    deposit_minor BIGINT NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    evaluation_input JSONB NOT NULL,
    evaluation_result JSONB NOT NULL,
    terms_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (reservation_id, revision),
    FOREIGN KEY (reservation_id, restaurant_id)
        REFERENCES reservations(id, restaurant_id) ON DELETE CASCADE,
    FOREIGN KEY (policy_version_id, restaurant_id)
        REFERENCES policy_versions(id, restaurant_id) ON DELETE RESTRICT
);

CREATE TABLE reservation_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    reservation_id UUID NOT NULL,
    table_id UUID NOT NULL,
    occupied_period TSTZRANGE NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT isempty(occupied_period)),
    CHECK (lower_inc(occupied_period) AND NOT upper_inc(occupied_period)),
    FOREIGN KEY (reservation_id, restaurant_id)
        REFERENCES reservations(id, restaurant_id) ON DELETE CASCADE,
    FOREIGN KEY (table_id, restaurant_id)
        REFERENCES dining_tables(id, restaurant_id) ON DELETE RESTRICT,
    EXCLUDE USING gist (
        restaurant_id WITH =,
        table_id WITH =,
        occupied_period WITH &&
    ) WHERE (released_at IS NULL)
);
CREATE INDEX reservation_allocations_reservation
    ON reservation_allocations (reservation_id) WHERE released_at IS NULL;

CREATE TABLE table_occupancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    reservation_id UUID NOT NULL,
    table_id UUID NOT NULL,
    seated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (completed_at IS NULL OR completed_at > seated_at),
    FOREIGN KEY (reservation_id, restaurant_id)
        REFERENCES reservations(id, restaurant_id) ON DELETE RESTRICT,
    FOREIGN KEY (table_id, restaurant_id)
        REFERENCES dining_tables(id, restaurant_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX table_occupancies_one_active_per_table
    ON table_occupancies (restaurant_id, table_id) WHERE completed_at IS NULL;
CREATE UNIQUE INDEX table_occupancies_one_active_per_reservation_table
    ON table_occupancies (reservation_id, table_id) WHERE completed_at IS NULL;

CREATE TABLE reservation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT,
    from_status TEXT,
    to_status TEXT,
    reservation_version INTEGER NOT NULL CHECK (reservation_version > 0),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX reservation_events_timeline ON reservation_events (reservation_id, occurred_at);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT
);
CREATE INDEX outbox_events_pending ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX jobs_claimable ON jobs (run_at) WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE idempotency_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    actor_scope TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status INTEGER,
    response_body JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurant_id, actor_scope, operation, idempotency_key)
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID REFERENCES restaurants(id) ON DELETE RESTRICT,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID,
    reason TEXT,
    before_value JSONB,
    after_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_logs_restaurant_time ON audit_logs (restaurant_id, created_at DESC);
