-- 0003_value_completeness.sql
-- Persist per-day pricing completeness so understated days are repaired on
-- later syncs instead of being frozen by write-once inserts.

ALTER TABLE wallet_value_daily
    ADD COLUMN complete boolean NOT NULL DEFAULT true;

INSERT INTO schema_migrations(version) VALUES ('0003_value_completeness');
