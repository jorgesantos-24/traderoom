import { parseBinanceMessage } from './parsers.js';
import type { FeedAsset, FeedProvider, ParseResult, ProviderSpec, Tick } from './types.js';

const IGNORE: ParseResult = { kind: 'ignore' };
const TRADE_STREAM = /@(trade|aggTrade)$/;

/** `btcusdt@aggTrade` → `btcusdt@kline_1s`. */
const heartbeatOf = (stream: string): string => `${stream.slice(0, stream.indexOf('@'))}@kline_1s`;

/**
 * One combined-stream connection for every enabled asset, or null if there is nothing to subscribe.
 * Used for both the primary and the backup Binance endpoint: same streams, same parser.
 *
 * Assets on a trade stream are priced at the last trade, exactly what Binance shows and what its
 * candles are built from. Their kline_1s is subscribed too, as a heartbeat: it arrives every second
 * even when a quiet pair goes many seconds without a trade (bookTicker can also sit still for
 * 5+ s on ADA), so the asset does not go stale while the market is merely calm.
 * - With a trade already seen on this connection, a kline repeats that trade with a fresh receive time.
 * - Before the first trade (just connected), the kline close is used: Binance's own last price.
 * State lives per connection (this function runs on every connect), so nothing from before a
 * disconnect is ever revived.
 */
export function binanceSpec(baseUrl: string, assets: readonly FeedAsset[], name: FeedProvider = 'binance'): ProviderSpec | null {
  if (assets.length === 0) return null;
  const streams: string[] = [];
  const tradeSymbols = new Set<string>();
  for (const a of assets) {
    streams.push(a.binanceStream);
    if (TRADE_STREAM.test(a.binanceStream)) {
      tradeSymbols.add(a.symbol);
      streams.push(heartbeatOf(a.binanceStream));
    }
  }
  const last = new Map<string, Tick>();
  const url = new URL(baseUrl);
  // Stream names are validated on load (`[a-z0-9]+@bookTicker` etc.), so the slash-joined list is URL safe.
  url.search = `streams=${streams.join('/')}`;
  return {
    name,
    url: url.toString(),
    onOpenMessages: [],
    parse: (raw, recvMs) => {
      const r = parseBinanceMessage(raw, recvMs, name);
      if (r.kind !== 'tick') return r;
      const symbol = r.tick.symbol;
      if (!tradeSymbols.has(symbol)) return r.kline ? IGNORE : r;
      if (r.quote) return IGNORE;
      if (r.kline) {
        const prev = last.get(symbol);
        // Same price and time as the last trade, fresh receive time: the market is alive, the price unchanged.
        const tick = prev ? { ...prev, recvMs } : r.tick;
        last.set(symbol, tick);
        return { kind: 'tick', tick };
      }
      // A trade older than what we hold (e.g. before the kline that seeded the price) is already reflected.
      const prev = last.get(symbol);
      if (prev && r.tick.ts < prev.ts) return IGNORE;
      last.set(symbol, r.tick);
      return r;
    },
  };
}
