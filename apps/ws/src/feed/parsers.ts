import { midPrice } from './decimal.js';
import type { FeedProvider, ParseResult } from './types.js';

const DECIMAL = /^\d+(\.\d+)?$/;
const IGNORE: ParseResult = { kind: 'ignore' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Returns the price as a positive finite number, or null if it is not a plain decimal string. */
function priceValue(p: unknown): number | null {
  if (typeof p !== 'string' || p.length > 40 || !DECIMAL.test(p)) return null;
  const v = Number(p);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Mid of best bid and best ask, or an error when either side is missing or the book is crossed.
 * Spot bookTicker has the same meaning on every Binance endpoint, so a failover keeps the price identical.
 */
function quoteMid(
  symbol: string,
  bid: unknown,
  ask: unknown,
  ts: number,
  recvMs: number,
  provider: FeedProvider,
): ParseResult {
  const b = priceValue(bid);
  const a = priceValue(ask);
  if (b === null || a === null) return { kind: 'error', message: 'malformed quote' };
  // A crossed book is a transient glitch; skip it rather than publish a bogus mid.
  if (a < b) return IGNORE;
  const price = midPrice(bid as string, ask as string);
  return { kind: 'tick', tick: { symbol, price, value: Number(price), ts, recvMs, provider }, quote: true };
}

/**
 * Binance combined stream. Supported payloads in `data`:
 * - bookTicker: `{"u":400900217,"s":"BTCUSDT","b":"75552.62","B":"1.2","a":"75552.64","A":"0.3"}` → mid price.
 *   Spot bookTicker carries no timestamp, so `ts` is the receive time.
 * - trade / aggTrade: `{"e":"trade","s":"BTCUSDT","p":"75552.63","T":1793217464000,...}` → last trade price.
 * - kline: `{"e":"kline","E":1793217465000,"s":"BTCUSDT","k":{"c":"75552.63",...}}` → close (= last trade
 *   price as of `E`), flagged `kline`. kline_1s arrives every second even without trades.
 * `provider` says which Binance endpoint the message came from.
 */
export function parseBinanceMessage(raw: string, recvMs: number, provider: FeedProvider = 'binance'): ParseResult {
  const msg = parseJson(raw);
  if (!isRecord(msg)) return { kind: 'error', message: 'invalid JSON' };
  // Replies to SUBSCRIBE-style requests and server errors.
  if ('error' in msg) return { kind: 'error', message: JSON.stringify(msg['error']) };
  const data = msg['data'];
  if (!isRecord(data)) return IGNORE;
  const symbol = data['s'];

  if (data['e'] === undefined && 'b' in data && 'a' in data) {
    if (typeof symbol !== 'string') return { kind: 'error', message: 'malformed quote' };
    return quoteMid(symbol, data['b'], data['a'], recvMs, recvMs, provider);
  }

  if (data['e'] === 'kline') {
    const k = data['k'];
    const ts = data['E'];
    const value = isRecord(k) ? priceValue(k['c']) : null;
    if (typeof symbol !== 'string' || typeof ts !== 'number' || !Number.isFinite(ts) || value === null || !isRecord(k)) {
      return { kind: 'error', message: 'malformed kline event' };
    }
    return { kind: 'tick', tick: { symbol, price: k['c'] as string, value, ts, recvMs, provider }, kline: true };
  }

  if (data['e'] !== 'trade' && data['e'] !== 'aggTrade') return IGNORE;
  const ts = data['T'];
  const value = priceValue(data['p']);
  if (typeof symbol !== 'string' || typeof ts !== 'number' || !Number.isFinite(ts) || value === null) {
    return { kind: 'error', message: 'malformed trade event' };
  }
  return {
    kind: 'tick',
    tick: { symbol, price: data['p'] as string, value, ts, recvMs, provider },
  };
}
