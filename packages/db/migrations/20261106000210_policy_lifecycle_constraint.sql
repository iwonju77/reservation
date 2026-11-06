ALTER TABLE policy_versions DROP CONSTRAINT policy_versions_check;

ALTER TABLE policy_versions
    ADD CONSTRAINT policy_versions_publication_time_check
    CHECK (
        (status = 'DRAFT' AND published_at IS NULL)
        OR (status IN ('PUBLISHED', 'RETIRED') AND published_at IS NOT NULL)
    );
