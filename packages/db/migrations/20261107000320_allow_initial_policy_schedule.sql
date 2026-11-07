CREATE OR REPLACE FUNCTION protect_published_policy_schedule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_policy_id UUID;
    target_status TEXT;
    schedule_exists BOOLEAN;
BEGIN
    target_policy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_version_id ELSE NEW.policy_version_id END;
    SELECT status INTO target_status FROM policy_versions WHERE id = target_policy_id;
    IF target_status <> 'DRAFT' AND pg_trigger_depth() = 1 THEN
        IF TG_OP = 'INSERT' THEN
            SELECT EXISTS (SELECT 1 FROM policy_schedules WHERE policy_version_id = target_policy_id)
            INTO schedule_exists;
            IF NOT schedule_exists THEN RETURN NEW; END IF;
        END IF;
        RAISE EXCEPTION 'schedule of a published policy is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
