CREATE OR REPLACE FUNCTION protect_published_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
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
