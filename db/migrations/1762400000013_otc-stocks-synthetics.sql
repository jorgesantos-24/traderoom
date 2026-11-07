-- Up Migration
-- Category shown to clients (asset picker): crypto, stocks (OTC) or synthetic indices.
alter table assets add column category text not null default 'crypto' check (category in ('crypto', 'stocks', 'synthetic'));
-- Long-run trend of an OTC asset, % per hour (Bull/Bear Market). 0 = no trend: the price hovers around its reference level.
-- Capped at 5% of the volatility: then even on the longest trade (30 min) always betting with the trend wins about
-- 51.4% of the time, below the ~52.1% needed to profit at a 92% payout. A stronger trend would be free money for clients.
alter table assets add column otc_drift_pct_hour numeric(6,3) not null default 0;
alter table assets add constraint assets_otc_drift_cap check (otc_drift_pct_hour = 0 or abs(otc_drift_pct_hour) <= 0.05 * otc_vol_pct_hour);

-- Start prices are reference levels for the generator, not live quotes.
insert into assets (symbol, display, kind, category, payout_pct, sort, otc_start_price, otc_vol_pct_hour, otc_decimals, otc_drift_pct_hour) values
  ('AAPLOTC',  'Apple (OTC)',            'otc', 'stocks',    92, 200, 230.00, 0.9, 2, 0),
  ('AMZNOTC',  'Amazon (OTC)',           'otc', 'stocks',    92, 210, 215.00, 1.0, 2, 0),
  ('GOOGLOTC', 'Google (OTC)',           'otc', 'stocks',    92, 220, 190.00, 1.0, 2, 0),
  ('METAOTC',  'Meta (OTC)',             'otc', 'stocks',    92, 230, 640.00, 1.2, 2, 0),
  ('MSFTOTC',  'Microsoft (OTC)',        'otc', 'stocks',    92, 240, 450.00, 0.8, 2, 0),
  ('TSLAOTC',  'Tesla (OTC)',            'otc', 'stocks',    92, 250, 330.00, 1.8, 2, 0),
  ('NFLXOTC',  'Netflix (OTC)',          'otc', 'stocks',    92, 260, 980.00, 1.3, 2, 0),
  ('KOOTC',    'Coca-Cola (OTC)',        'otc', 'stocks',    92, 270, 70.00,  0.6, 2, 0),
  ('DISOTC',   'Disney (OTC)',           'otc', 'stocks',    92, 280, 110.00, 0.9, 2, 0),
  ('FOTC',     'Ford (OTC)',             'otc', 'stocks',    92, 290, 11.00,  1.1, 3, 0),
  ('MCDOTC',   'McDonald''s (OTC)',      'otc', 'stocks',    92, 300, 300.00, 0.6, 2, 0),
  ('NKEOTC',   'Nike (OTC)',             'otc', 'stocks',    92, 310, 75.00,  1.0, 2, 0),
  ('AXPOTC',   'American Express (OTC)', 'otc', 'stocks',    92, 320, 300.00, 0.9, 2, 0),
  ('BULLIDX',  'Bull Market',            'otc', 'synthetic', 92, 400, 1000.00, 1.5, 2, 0.075),
  ('BEARIDX',  'Bear Market',            'otc', 'synthetic', 92, 410, 1000.00, 1.5, 2, -0.075)
on conflict (symbol) do nothing;

-- Down Migration
delete from price_snapshots where asset_id in (select id from assets where category in ('stocks', 'synthetic'));
delete from assets where category in ('stocks', 'synthetic') and not exists (select 1 from orders o where o.asset_id = assets.id);
alter table assets drop constraint assets_otc_drift_cap;
alter table assets drop column otc_drift_pct_hour;
alter table assets drop column category;
