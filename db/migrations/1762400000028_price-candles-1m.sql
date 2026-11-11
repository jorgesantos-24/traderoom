-- Up Migration
-- One-minute candles of every asset, kept for good. price_snapshots (1 per second) is pruned after
-- 7 days; retention rolls each minute up into this table first, so charts keep their full history
-- (OTC assets have no exchange to fetch it from).
create table price_candles_1m (
  asset_id int not null references assets(id) on delete cascade,
  t timestamptz not null,
  o numeric(20, 8) not null,
  h numeric(20, 8) not null,
  l numeric(20, 8) not null,
  c numeric(20, 8) not null,
  primary key (asset_id, t)
);

-- Down Migration
drop table price_candles_1m;
