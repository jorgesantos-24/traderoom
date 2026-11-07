-- Up Migration
-- Price = last trade (aggTrade), the same number Binance shows and builds its candles from. The
-- bid/ask mid sat half a tick away from it (SOL 90.195 while Binance showed 90.20). The relay also
-- subscribes each pair's kline_1s as a heartbeat (it arrives every second, trades or not), so quiet
-- pairs no longer go stale between trades.
update assets
set binance_stream = lower(symbol) || '@aggTrade'
where binance_stream = lower(symbol) || '@bookTicker';

-- Down Migration
update assets
set binance_stream = lower(symbol) || '@bookTicker'
where binance_stream = lower(symbol) || '@aggTrade';
