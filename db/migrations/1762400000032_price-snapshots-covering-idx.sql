-- Up Migration
-- Chart candles read days of per-second prices for one asset. Rows of all assets are interleaved on
-- disk, so the plain (asset_id, captured_at) index cost one heap page per row: minutes per chart on
-- the small instance. With price included the read is an index-only scan over contiguous pages.
-- Production got it with "create index concurrently" (2026-11-17); "if not exists" makes this a no-op there.
create index if not exists price_snapshots_asset_time_price_idx on price_snapshots (asset_id, captured_at) include (price);

-- Down Migration
drop index if exists price_snapshots_asset_time_price_idx;
