-- Up Migration
-- OTC assets: prices come from our own generator (random walk), not from an exchange.
alter table assets add column kind text not null default 'market' check (kind in ('market', 'otc'));
alter table assets alter column binance_stream drop not null;
alter table assets add column otc_start_price numeric(20,8) check (otc_start_price > 0);
-- Typical move over one hour, in percent (e.g. 1.5 = the price usually moves about 1.5% per hour).
alter table assets add column otc_vol_pct_hour numeric(6,3) check (otc_vol_pct_hour > 0 and otc_vol_pct_hour <= 20);
alter table assets add column otc_decimals int check (otc_decimals between 0 and 8);
alter table assets add constraint assets_kind_fields check (
  (kind = 'market' and binance_stream is not null)
  or (kind = 'otc' and otc_start_price is not null and otc_vol_pct_hour is not null and otc_decimals is not null)
);

insert into assets (symbol, display, kind, payout_pct, sort, otc_start_price, otc_vol_pct_hour, otc_decimals) values
  ('BTCOTC', 'Bitcoin (OTC)',  'otc', 92, 100, 75770.53, 0.8, 2),
  ('ETHOTC', 'Ethereum (OTC)', 'otc', 92, 110, 2234.06,  1.0, 2),
  ('ADAOTC', 'Cardano (OTC)',  'otc', 92, 120, 0.1812,   1.4, 4),
  ('XRPOTC', 'XRP (OTC)',      'otc', 92, 130, 1.1615,   1.2, 4)
on conflict (symbol) do nothing;

-- Down Migration
delete from price_snapshots where asset_id in (select id from assets where kind = 'otc');
delete from assets where kind = 'otc' and not exists (select 1 from orders o where o.asset_id = assets.id);
alter table assets drop constraint assets_kind_fields;
alter table assets drop column otc_decimals;
alter table assets drop column otc_vol_pct_hour;
alter table assets drop column otc_start_price;
alter table assets alter column binance_stream set not null;
alter table assets drop column kind;
