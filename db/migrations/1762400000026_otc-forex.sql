-- Up Migration
-- Currency pairs as OTC assets (category "forex"): prices from our own generator, 24 hours a day,
-- like the OTC stocks. Start prices are reference levels for the generator, not live quotes.
-- Volatility is low (as in real forex, ~0.25% per hour); admins can change it in /admin.
-- They show up in the OTC intervention page by themselves (every enabled OTC asset does).
alter table assets drop constraint assets_category_check;
alter table assets add constraint assets_category_check check (category in ('crypto', 'stocks', 'synthetic', 'forex'));

insert into assets (symbol, display, kind, category, payout_pct, sort, otc_start_price, otc_vol_pct_hour, otc_decimals, otc_drift_pct_hour) values
  ('EURUSDOTC', 'EUR/USD (OTC)', 'otc', 'forex', 92, 150, 1.16000,   0.25, 5, 0),
  ('GBPUSDOTC', 'GBP/USD (OTC)', 'otc', 'forex', 92, 151, 1.33000,   0.25, 5, 0),
  ('USDJPYOTC', 'USD/JPY (OTC)', 'otc', 'forex', 92, 152, 150.000,   0.30, 3, 0),
  ('AUDUSDOTC', 'AUD/USD (OTC)', 'otc', 'forex', 92, 153, 0.66000,   0.30, 5, 0),
  ('USDCADOTC', 'USD/CAD (OTC)', 'otc', 'forex', 92, 154, 1.38000,   0.25, 5, 0),
  ('EURGBPOTC', 'EUR/GBP (OTC)', 'otc', 'forex', 92, 155, 0.87000,   0.20, 5, 0)
on conflict (symbol) do nothing;

-- Down Migration
delete from price_snapshots where asset_id in (select id from assets where category = 'forex');
delete from assets where category = 'forex' and not exists (select 1 from orders o where o.asset_id = assets.id);
alter table assets drop constraint assets_category_check;
alter table assets add constraint assets_category_check check (category in ('crypto', 'stocks', 'synthetic'));
