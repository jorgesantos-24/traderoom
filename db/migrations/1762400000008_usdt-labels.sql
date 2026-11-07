-- Up Migration
-- Prices come from Binance's USDT pairs (BTCUSDT…), so name them that way: "BTC/USDT", not "BTC/USD".
-- A Bitstamp or Coinbase BTC/USD chart trades a few dollars away and draws different wicks.
update assets set display = display || 'T' where symbol like '%USDT' and display like '%/USD';

-- Down Migration
update assets set display = left(display, -1) where symbol like '%USDT' and display like '%/USDT';
