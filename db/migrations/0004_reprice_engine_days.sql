-- 0004_reprice_engine_days.sql
-- Mark engine-sourced days incomplete so the next sync reprices them.

UPDATE wallet_value_daily
   SET complete = false
 WHERE source = 'engine';

INSERT INTO schema_migrations(version) VALUES ('0004_reprice_engine_days');
