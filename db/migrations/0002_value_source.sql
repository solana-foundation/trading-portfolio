-- 0002_value_source.sql
-- Tag each stored day with its source: 'engine' (our reconstruction) or
-- 'birdeye' (vendor net-worth history used only for days before the engine's
-- reachable genesis on truncated wallets).

ALTER TABLE wallet_value_daily
    ADD COLUMN source text NOT NULL DEFAULT 'engine';

INSERT INTO schema_migrations(version) VALUES ('0002_value_source');
