CREATE TABLE reservation_access_tokens (
    reservation_id UUID PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reservation_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    terms_version TEXT NOT NULL CHECK (length(btrim(terms_version)) > 0),
    privacy_version TEXT NOT NULL CHECK (length(btrim(privacy_version)) > 0),
    locale TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (reservation_id, terms_version, privacy_version)
);
