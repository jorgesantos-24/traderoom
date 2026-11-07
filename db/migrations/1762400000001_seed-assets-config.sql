-- Up Migration
insert into assets (symbol, display, binance_stream, sort) values
  ('BTCUSDT',  'BTC/USD',  'btcusdt@trade',  10),
  ('ETHUSDT',  'ETH/USD',  'ethusdt@trade',  20),
  ('SOLUSDT',  'SOL/USD',  'solusdt@trade',  30),
  ('BNBUSDT',  'BNB/USD',  'bnbusdt@trade',  40),
  ('XRPUSDT',  'XRP/USD',  'xrpusdt@trade',  50),
  ('DOGEUSDT', 'DOGE/USD', 'dogeusdt@trade', 60),
  ('ADAUSDT',  'ADA/USD',  'adausdt@trade',  70)
on conflict (symbol) do nothing;

insert into config (key, value) values
  ('orders.min_stake_cents', '100'),
  ('orders.max_stake_cents', '1000000'),
  ('orders.durations_sec',   '[60, 300]')
on conflict (key) do nothing;

-- Down Migration
delete from config where key in ('orders.min_stake_cents', 'orders.max_stake_cents', 'orders.durations_sec');
delete from assets where symbol in ('BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT');
