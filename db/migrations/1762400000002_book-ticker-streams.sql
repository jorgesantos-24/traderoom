-- Up Migration
-- @trade goes quiet for seconds on low-volume pairs (ADA was stale 26% of the time in a live test),
-- which trips the 2 s stale guard. @bookTicker updates on every best bid/ask change; price = mid.
update assets
set binance_stream = lower(symbol) || '@bookTicker'
where binance_stream = lower(symbol) || '@trade';

-- Down Migration
update assets
set binance_stream = lower(symbol) || '@trade'
where binance_stream = lower(symbol) || '@bookTicker';
