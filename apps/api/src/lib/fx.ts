/**
 * Dollar quote for the platform: balances are in US dollars, Pix moves reais.
 * A deposit of R$ X credits X / depositRate dollars; a withdrawal of $Y sends Y × withdrawRate reais.
 */
export interface FxQuote {
  /** BRL paid per US$ 1 credited (ask side, plus the spread). */
  depositRate: number;
  /** BRL sent per US$ 1 withdrawn (bid side, minus the spread). */
  withdrawRate: number;
  source: string;
  /** When the quote was fetched (ms). */
  at: number;
}

export interface FxService {
  /** The current quote; throws FxUnavailableError when no fresh enough quote can be had. */
  quote(): Promise<FxQuote>;
}

export class FxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxUnavailableError';
  }
}

interface RawQuote {
  bid: number;
  ask: number;
  source: string;
}

export type RateSource = (fetchImpl: typeof fetch, timeoutMs: number) => Promise<RawQuote>;

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  // Sanity band: the real has traded between 1 and 10 per dollar for decades.
  return Number.isFinite(n) && n > 1 && n < 20 ? n : null;
};

/** Commercial dollar from AwesomeAPI (free, Brazilian). */
export const awesomeApi: RateSource = async (fetchImpl, timeoutMs) => {
  const res = await fetchImpl('https://economia.awesomeapi.com.br/json/last/USD-BRL', {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`awesomeapi ${res.status}`);
  const body = (await res.json()) as { USDBRL?: { bid?: unknown; ask?: unknown } };
  const bid = positive(body.USDBRL?.bid);
  const ask = positive(body.USDBRL?.ask);
  if (!bid || !ask) throw new Error('awesomeapi: malformed quote');
  return { bid, ask: Math.max(ask, bid), source: 'awesomeapi' };
};

/** Commercial dollar from open.er-api.com (free, updated once a day; one mid rate, no bid/ask). */
export const openErApi: RateSource = async (fetchImpl, timeoutMs) => {
  const res = await fetchImpl('https://open.er-api.com/v6/latest/USD', {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`open.er-api ${res.status}`);
  const body = (await res.json()) as { result?: unknown; rates?: { BRL?: unknown } };
  const mid = body.result === 'success' ? positive(body.rates?.BRL) : null;
  if (!mid) throw new Error('open.er-api: malformed quote');
  return { bid: mid, ask: mid, source: 'open-er-api' };
};

/** Last resort: Binance USDT/BRL book ticker (tracks the dollar, usually a little above it). */
export const binanceUsdtBrl =
  (baseUrl: string): RateSource =>
  async (fetchImpl, timeoutMs) => {
    const res = await fetchImpl(new URL('/api/v3/ticker/bookTicker?symbol=USDTBRL', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const body = (await res.json()) as { bidPrice?: unknown; askPrice?: unknown };
    const bid = positive(body.bidPrice);
    const ask = positive(body.askPrice);
    if (!bid || !ask) throw new Error('binance: malformed quote');
    return { bid, ask: Math.max(ask, bid), source: 'binance-usdtbrl' };
  };

export interface FxOptions {
  sources: RateSource[];
  /** Platform margin on each side, in percent (0.5 = 0,5%). */
  spreadPct?: number;
  /** A quote is reused for this long. */
  cacheMs?: number;
  /** When every source fails, the last quote is still used up to this age. */
  maxStaleMs?: number;
  timeoutMs?: number;
  /** A source that failed is skipped for this long (e.g. one that rate-limits us). */
  cooldownMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/** Rates are kept to 4 decimals, as quoted. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function createFxService(opts: FxOptions): FxService {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 60_000;
  const maxStaleMs = opts.maxStaleMs ?? 30 * 60_000;
  const spread = (opts.spreadPct ?? 0) / 100;
  const cooldownMs = opts.cooldownMs ?? 10 * 60_000;
  const failedAt = new Map<RateSource, number>();
  let last: FxQuote | null = null;
  let inflight: Promise<FxQuote> | null = null;

  async function refresh(): Promise<FxQuote> {
    const fresh = opts.sources.filter((s) => now() - (failedAt.get(s) ?? -Infinity) >= cooldownMs);
    // All cooling down: try them all rather than none.
    for (const source of fresh.length > 0 ? fresh : opts.sources) {
      try {
        const raw = await source(fetchImpl, opts.timeoutMs ?? 4_000);
        last = {
          depositRate: round4(raw.ask * (1 + spread)),
          withdrawRate: round4(raw.bid * (1 - spread)),
          source: raw.source,
          at: now(),
        };
        failedAt.delete(source);
        return last;
      } catch (err) {
        failedAt.set(source, now());
        opts.onError?.(err);
      }
    }
    if (last && now() - last.at <= maxStaleMs) return last;
    throw new FxUnavailableError('no dollar quote available');
  }

  return {
    async quote() {
      if (last && now() - last.at < cacheMs) return last;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

/** Fixed quote, for tests and development without internet. */
export function fixedFx(depositRate: number, withdrawRate = depositRate): FxService {
  return { quote: async () => ({ depositRate, withdrawRate, source: 'fixed', at: Date.now() }) };
}

/** BRL cents → USD cents at `rate` BRL per dollar; rounds down (never credits more than was paid). */
export const brlToUsdCents = (brlCents: number, rate: number): number => Math.floor(brlCents / rate + 1e-9);
/** USD cents → BRL cents at `rate` BRL per dollar; rounds down. */
export const usdToBrlCents = (usdCents: number, rate: number): number => Math.floor(usdCents * rate + 1e-9);
