ALTER TABLE users
    ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN mfa_enrolled_at TIMESTAMPTZ,
    ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN locked_until TIMESTAMPTZ,
    ADD COLUMN last_login_at TIMESTAMPTZ,
    ADD CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0),
    ADD CONSTRAINT users_mfa_enrollment_check CHECK (NOT mfa_required OR mfa_enrolled_at IS NOT NULL);

CREATE TABLE password_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL CHECK (length(password_hash) >= 50),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    mfa_verified_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CHECK (mfa_verified_at IS NULL OR mfa_verified_at >= created_at)
);
CREATE INDEX auth_sessions_active_user
    ON auth_sessions (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry
    ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
