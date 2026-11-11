import { z } from 'zod';

/** binance/binance_backup: Binance spot through two endpoints. otc: our own generator (OTC assets). */
export const FEED_PROVIDERS = ['binance', 'binance_backup', 'otc'] as const;
export type FeedProvider = (typeof FEED_PROVIDERS)[number];

/** A symbol is "stale" (orders refused) after this long without an accepted tick. */
export const FEED_STALE_MS = 2000;
/** TTL of `px:<symbol>` in Redis. */
export const PRICE_TTL_MS = 5000;

const decimal = /^\d+(\.\d+)?$/;

/** Value stored at `px:<symbol>` by the relay. */
export const PriceRecordSchema = z.object({
  /** Exact decimal string as received from the provider (fits numeric(20,8)). */
  p: z.string().regex(decimal),
  /** Exchange trade time, epoch ms. */
  ts: z.number().int().nonnegative(),
  /** Local receive time, epoch ms. Staleness is judged on this, never on exchange clocks. */
  rt: z.number().int().nonnegative(),
  src: z.enum(FEED_PROVIDERS),
  /** Set while a price override changes this price: the otc_overrides id. */
  ov: z.string().optional(),
  /** With `ov`: the price without the override (provider tick, or the OTC natural path). */
  realPrice: z.string().regex(decimal).optional(),
});
export type PriceRecord = z.infer<typeof PriceRecordSchema>;

/** Parses a raw `px:<symbol>` value; returns null when missing or malformed. */
export function parsePriceRecord(raw: string | null | undefined): PriceRecord | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = PriceRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when there is no price or the newest one is older than `staleMs`. */
export function isPriceStale(rec: PriceRecord | null, now: number, staleMs: number = FEED_STALE_MS): boolean {
  return rec === null || now - rec.rt > staleMs;
}

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** Candles fetched from Binance per (symbol, interval); requests are served as a slice of this. */
export const CANDLES_UPSTREAM_LIMIT = 1000;
export const CANDLES_DEFAULT_LIMIT = 500;

export const SymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9]{2,20}$/, 'Símbolo inválido.'));

export const CandlesQuery = z.object({
  symbol: SymbolSchema,
  interval: z.enum(CANDLE_INTERVALS, `Intervalo inválido. Use: ${CANDLE_INTERVALS.join(', ')}.`).default('1m'),
  limit: z.coerce
    .number()
    .int('O limite precisa ser inteiro.')
    .min(1, 'O limite mínimo é 1.')
    .max(CANDLES_UPSTREAM_LIMIT, `O limite máximo é ${CANDLES_UPSTREAM_LIMIT}.`)
    .default(CANDLES_DEFAULT_LIMIT),
  /** Older history: only candles that open before this time (epoch ms). Without it, the latest ones. */
  before: z.coerce.number().int('Data inválida.').positive('Data inválida.').optional(),
});
export type CandlesQuery = z.infer<typeof CandlesQuery>;

export interface Candle {
  /** Open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandlesResponse {
  symbol: string;
  interval: CandleInterval;
  candles: Candle[];
}
