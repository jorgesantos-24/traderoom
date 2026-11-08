-- Up Migration
-- The candles route looks up the overrides of an asset by candle, ended ones included.
create index otc_overrides_asset_candle on otc_overrides (asset_id, candle_open_ms);

-- Down Migration
drop index if exists otc_overrides_asset_candle;
