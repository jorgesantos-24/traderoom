import { z } from 'zod';
import type { Candle, CandleInterval } from '@traderoom/shared';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Set when Binance asks us to back off (429/418). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** `before` (epoch ms): only candles opening before it (older history); without it, the latest ones. */
export type KlinesFetcher = (symbol: string, interval: CandleInterval, limit: number, before?: number) => Promise<Candle[]>;

const num = z.string().transform((s, ctx) => {
  const v = Number(s);
  if (!Number.isFinite(v)) {
    ctx.addIssue({ code: 'custom', message: 'not a number' });
    return z.NEVER;
  }
  return v;
});

// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...]
const KlinesSchema = z.array(z.tuple([z.number().int(), num, num, num, num, num]).rest(z.unknown()));

export function parseKlines(json: unknown): Candle[] {
  const rows = KlinesSchema.parse(json);
  return rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

/** Binance sends Retry-After in seconds. Defaults to 60 s when missing or malformed. */
export function retryAfterMs(header: string | null, fallbackMs = 60_000): number {
  const s = header === null ? NaN : Number(header);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 3_600_000) : fallbackMs;
}

export function createKlinesFetcher(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; onStatus?: (status: number | 'error') => void } = {},
): KlinesFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return async (symbol, interval, limit, before) => {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (before !== undefined) url.searchParams.set('endTime', String(before - 1));
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (err) {
      opts.onStatus?.('error');
      throw new UpstreamError(`klines request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    opts.onStatus?.(res.status);
    // 429 = rate limited, 418 = IP banned for ignoring 429s. Both mean: stop calling.
    if (res.status === 429 || res.status === 418) {
      throw new UpstreamError(`binance ${res.status}`, res.status, retryAfterMs(res.headers.get('retry-after')));
    }
    if (!res.ok) throw new UpstreamError(`binance ${res.status}`, res.status);
    try {
      return parseKlines(await res.json());
    } catch (err) {
      throw new UpstreamError(`unexpected klines payload: ${err instanceof Error ? err.message : String(err)}`, res.status);
    }
  };
}
