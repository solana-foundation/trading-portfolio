-- 0001_value_history.sql
-- Daily wallet value store (FT-315): write-once per (wallet, day), shared
-- across all users tracking the wallet. price_daily caches immutable
-- historical prices. wallet_sync tracks backfill state and last access for
-- the inactivity TTL.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_sync (
    wallet           text PRIMARY KEY,
    backfilled       boolean NOT NULL DEFAULT false,
    genesis_day      date,
    truncated        boolean NOT NULL DEFAULT false,
    last_accessed_at timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_sync_by_last_accessed ON wallet_sync (last_accessed_at);

CREATE TABLE wallet_value_daily (
    wallet    text NOT NULL,
    day       date NOT NULL,
    value_usd double precision NOT NULL,
    PRIMARY KEY (wallet, day)
);

CREATE TABLE price_daily (
    mint      text NOT NULL,
    day       date NOT NULL,
    price_usd double precision NOT NULL,
    PRIMARY KEY (mint, day)
);

INSERT INTO schema_migrations(version) VALUES ('0001_value_history');
