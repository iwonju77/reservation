CREATE OR REPLACE FUNCTION protect_published_policy_schedule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target_policy_id UUID;
    target_status TEXT;
BEGIN
    target_policy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_version_id ELSE NEW.policy_version_id END;
    SELECT status INTO target_status FROM policy_versions WHERE id = target_policy_id;
    IF target_status <> 'DRAFT' AND pg_trigger_depth() = 1 THEN
        RAISE EXCEPTION 'schedule of a published policy is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER policy_schedules_immutable_after_publish
BEFORE INSERT OR UPDATE OR DELETE ON policy_schedules
FOR EACH ROW EXECUTE FUNCTION protect_published_policy_schedule();
