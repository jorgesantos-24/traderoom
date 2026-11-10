-- Up Migration
-- The rest of the USD currency pairs the Kyden platform offers as OTC binaries, with its payouts.
-- Start prices are reference levels for the generator (close to the Kyden OTC quotes), not live quotes.
-- Volatility (% per hour): pegged currencies move little, emerging ones more; admins can change it in /admin.
insert into assets (symbol, display, kind, category, payout_pct, sort, otc_start_price, otc_vol_pct_hour, otc_decimals, otc_drift_pct_hour) values
  ('NZDUSDOTC', 'NZD/USD (OTC)', 'otc', 'forex', 86, 156, 0.600445,  0.30, 6, 0),
  ('PENUSDOTC', 'PEN/USD (OTC)', 'otc', 'forex', 86, 157, 0.338035,  0.25, 6, 0),
  ('USDAEDOTC', 'USD/AED (OTC)', 'otc', 'forex', 86, 158, 3.672898,  0.10, 6, 0),
  ('USDARSOTC', 'USD/ARS (OTC)', 'otc', 'forex', 86, 159, 1544.075,  0.40, 3, 0),
  ('USDBDTOTC', 'USD/BDT (OTC)', 'otc', 'forex', 86, 160, 124.8170,  0.15, 4, 0),
  ('USDCHFOTC', 'USD/CHF (OTC)', 'otc', 'forex', 86, 161, 0.824655,  0.25, 6, 0),
  ('USDCLPOTC', 'USD/CLP (OTC)', 'otc', 'forex', 86, 162, 1028.935,  0.30, 3, 0),
  ('USDCOPOTC', 'USD/COP (OTC)', 'otc', 'forex', 86, 163, 3139.742,  0.35, 3, 0),
  ('USDDOPOTC', 'USD/DOP (OTC)', 'otc', 'forex', 86, 164, 60.95855,  0.20, 5, 0),
  ('USDHKDOTC', 'USD/HKD (OTC)', 'otc', 'forex', 86, 165, 7.863805,  0.10, 6, 0),
  ('USDIDROTC', 'USD/IDR (OTC)', 'otc', 'forex', 86, 166, 18163.67,  0.25, 2, 0),
  ('USDINROTC', 'USD/INR (OTC)', 'otc', 'forex', 86, 167, 94.98050,  0.20, 5, 0),
  ('USDMXNOTC', 'USD/MXN (OTC)', 'otc', 'forex', 86, 168, 18.59767,  0.35, 5, 0),
  ('USDMYROTC', 'USD/MYR (OTC)', 'otc', 'forex', 86, 169, 4.114755,  0.20, 6, 0),
  ('USDNGNOTC', 'USD/NGN (OTC)', 'otc', 'forex', 86, 170, 1350.809,  0.40, 3, 0),
  ('USDNOKOTC', 'USD/NOK (OTC)', 'otc', 'forex', 86, 171, 9.549295,  0.30, 6, 0),
  ('USDPLNOTC', 'USD/PLN (OTC)', 'otc', 'forex', 86, 172, 3.934945,  0.30, 6, 0),
  ('USDSAROTC', 'USD/SAR (OTC)', 'otc', 'forex', 86, 173, 3.756945,  0.10, 6, 0),
  ('USDSEKOTC', 'USD/SEK (OTC)', 'otc', 'forex', 86, 174, 9.867385,  0.30, 6, 0),
  ('USDSGDOTC', 'USD/SGD (OTC)', 'otc', 'forex', 86, 175, 1.301825,  0.20, 6, 0),
  ('USDTHBOTC', 'USD/THB (OTC)', 'otc', 'forex', 86, 176, 33.58390,  0.25, 5, 0),
  ('USDTRYOTC', 'USD/TRY (OTC)', 'otc', 'forex', 86, 177, 50.19629,  0.40, 5, 0),
  ('USDZAROTC', 'USD/ZAR (OTC)', 'otc', 'forex', 86, 178, 16.60617,  0.40, 5, 0),
  ('USDBOBOTC', 'USD/BOB (OTC)', 'otc', 'forex', 85, 179, 12.00773,  0.15, 5, 0),
  ('USDPHPOTC', 'USD/PHP (OTC)', 'otc', 'forex', 85, 180, 62.89275,  0.20, 5, 0),
  ('USDVNDOTC', 'USD/VND (OTC)', 'otc', 'forex', 85, 181, 25575.41,  0.15, 2, 0),
  ('USDBRLOTC', 'USD/BRL (OTC)', 'otc', 'forex', 83, 182, 5.334215,  0.35, 6, 0)
on conflict (symbol) do nothing;

-- Payouts of the first pairs as on the Kyden platform (they started at the 92% of the other OTC assets).
update assets set payout_pct = 85 where symbol in ('EURUSDOTC', 'EURGBPOTC');
update assets set payout_pct = 86 where symbol in ('GBPUSDOTC', 'AUDUSDOTC', 'USDCADOTC');
update assets set payout_pct = 84 where symbol = 'USDJPYOTC';

-- Down Migration
update assets set payout_pct = 92 where symbol in ('EURUSDOTC', 'GBPUSDOTC', 'USDJPYOTC', 'AUDUSDOTC', 'USDCADOTC', 'EURGBPOTC');
delete from price_snapshots where asset_id in (select id from assets where symbol in (
  'NZDUSDOTC', 'PENUSDOTC', 'USDAEDOTC', 'USDARSOTC', 'USDBDTOTC', 'USDCHFOTC', 'USDCLPOTC', 'USDCOPOTC', 'USDDOPOTC',
  'USDHKDOTC', 'USDIDROTC', 'USDINROTC', 'USDMXNOTC', 'USDMYROTC', 'USDNGNOTC', 'USDNOKOTC', 'USDPLNOTC', 'USDSAROTC',
  'USDSEKOTC', 'USDSGDOTC', 'USDTHBOTC', 'USDTRYOTC', 'USDZAROTC', 'USDBOBOTC', 'USDPHPOTC', 'USDVNDOTC', 'USDBRLOTC'));
delete from assets where symbol in (
  'NZDUSDOTC', 'PENUSDOTC', 'USDAEDOTC', 'USDARSOTC', 'USDBDTOTC', 'USDCHFOTC', 'USDCLPOTC', 'USDCOPOTC', 'USDDOPOTC',
  'USDHKDOTC', 'USDIDROTC', 'USDINROTC', 'USDMXNOTC', 'USDMYROTC', 'USDNGNOTC', 'USDNOKOTC', 'USDPLNOTC', 'USDSAROTC',
  'USDSEKOTC', 'USDSGDOTC', 'USDTHBOTC', 'USDTRYOTC', 'USDZAROTC', 'USDBOBOTC', 'USDPHPOTC', 'USDVNDOTC', 'USDBRLOTC')
  and not exists (select 1 from orders o where o.asset_id = assets.id);
