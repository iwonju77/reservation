ALTER TABLE policy_versions
    ADD COLUMN name TEXT NOT NULL DEFAULT '기본 정책' CHECK (length(btrim(name)) > 0),
    ADD COLUMN description TEXT;

ALTER TABLE reservation_policy_rules
    DROP CONSTRAINT reservation_policy_rules_rule_type_check;
ALTER TABLE reservation_policy_rules
    ADD CONSTRAINT reservation_policy_rules_rule_type_check CHECK (rule_type IN (
        'BOOKING_WINDOW', 'PARTY_LIMIT', 'DURATION', 'CLEANUP', 'START_INTERVAL',
        'APPROVAL', 'MINIMUM_SPEND', 'DEPOSIT', 'CANCELLATION', 'WAITLIST', 'NO_SHOW'
    ));

CREATE OR REPLACE FUNCTION protect_published_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'published policy versions are immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
        IF NOT (
            OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
            AND NEW.id = OLD.id AND NEW.restaurant_id = OLD.restaurant_id
            AND NEW.version = OLD.version AND NEW.name = OLD.name
            AND NEW.description IS NOT DISTINCT FROM OLD.description
            AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by
            AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
            AND NEW.created_at = OLD.created_at
        ) THEN
            RAISE EXCEPTION 'published policy versions are immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER policy_versions_immutable_after_publish
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION protect_published_policy();

CREATE OR REPLACE FUNCTION protect_published_policy_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_policy_id UUID;
    target_status TEXT;
BEGIN
    target_policy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_version_id ELSE NEW.policy_version_id END;
    SELECT status INTO target_status FROM policy_versions WHERE id = target_policy_id;
    IF target_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'rules of published policy versions are immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.policy_version_id <> NEW.policy_version_id THEN
        SELECT status INTO target_status FROM policy_versions WHERE id = OLD.policy_version_id;
        IF target_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'rules of published policy versions are immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER reservation_policy_rules_immutable_after_publish
BEFORE INSERT OR UPDATE OR DELETE ON reservation_policy_rules
FOR EACH ROW EXECUTE FUNCTION protect_published_policy_rule();
