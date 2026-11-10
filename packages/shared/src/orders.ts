import { z } from 'zod';

export type Direction = 'call' | 'put';
export type OrderStatus = 'open' | 'won' | 'lost' | 'void';
export type LedgerKind =
  'credit' | 'debit' | 'stake' | 'payout' | 'refund' | 'adjust' | 'deposit' | 'deposit_reversal' | 'withdrawal' | 'withdrawal_return';

/** Every user has a real account and a demo (practice) account, each with its own balance. */
export const ACCOUNT_KINDS = ['real', 'demo'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const AccountKindSchema = z.enum(ACCOUNT_KINDS, 'Conta inválida: use real ou demo.');

/** Demo balance at sign-up, and what "recarregar" restores it to (US$ 10.000,00). */
export const DEMO_START_CENTS = 1_000_000;

/** Send a unique value per order attempt; retries with the same value return the same order. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const IdempotencyKeySchema = z
  .string('Envie o header Idempotency-Key.')
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Idempotency-Key inválido: use 8 a 100 caracteres [A-Za-z0-9_-].');

/** Max stake per order; the config table can lower it but never go above. */
export const MAX_STAKE_CENTS_HARD = 100_000_000;

export const CreateOrderInput = z.object({
  assetId: z.number('Informe o ativo.').int().positive('Ativo inválido.'),
  direction: z.enum(['call', 'put'], 'A direção deve ser call ou put.'),
  stakeCents: z
    .number('Informe o valor.')
    .int('O valor deve ser em centavos inteiros.')
    .positive('O valor deve ser positivo.')
    .max(MAX_STAKE_CENTS_HARD, 'Valor acima do máximo.'),
  durationSec: z.number('Informe a duração.').int('Duração inválida.').positive('Duração inválida.'),
  /** Which balance pays the stake; older clients that leave it out trade on the real account. */
  account: AccountKindSchema.default('real'),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;
/** What a client sends (`account` may be left out). */
export type CreateOrderRequest = z.input<typeof CreateOrderInput>;

export const PAGE_DEFAULT_LIMIT = 50;
export const PAGE_MAX_LIMIT = 100;

const limit = z.coerce
  .number()
  .int('O limite precisa ser inteiro.')
  .min(1, 'O limite mínimo é 1.')
  .max(PAGE_MAX_LIMIT, `O limite máximo é ${PAGE_MAX_LIMIT}.`)
  .default(PAGE_DEFAULT_LIMIT);

export const AccountQuery = z.object({ account: AccountKindSchema.default('real') });

export const ListOrdersQuery = z.object({
  account: AccountKindSchema.default('real'),
  status: z.enum(['open', 'won', 'lost', 'void'], 'Status inválido.').optional(),
  cursor: z.string().max(200).optional(),
  limit,
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuery>;

export const ListLedgerQuery = z.object({
  account: AccountKindSchema.default('real'),
  cursor: z.string().max(200).optional(),
  limit,
});
export type ListLedgerQuery = z.infer<typeof ListLedgerQuery>;

export interface OrderView {
  id: string;
  account: AccountKind;
  assetId: number;
  symbol: string;
  direction: Direction;
  stakeCents: number;
  payoutPct: number;
  durationSec: number;
  /** Decimal strings with 8 places, exactly as stored. */
  openPrice: string;
  closePrice: string | null;
  status: OrderStatus;
  /** What the order credited (or will credit if it wins): stake + profit, stake on void, 0 on loss. */
  payoutCents: number;
  /** Credit if this order wins; shown on open orders. */
  potentialPayoutCents: number;
  opensAt: string;
  expiresAt: string;
  settledAt: string | null;
  /** Set when the entry price was set by the platform (price override). */
  overrideId: string | null;
}

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface WalletView {
  account: AccountKind;
  balanceCents: number;
  currency: string;
  /** Stakes locked in open orders (already debited from the balance). */
  openStakeCents: number;
  openOrders: number;
}

export interface LedgerEntryView {
  id: string;
  kind: LedgerKind;
  deltaCents: number;
  balanceAfterCents: number;
  orderId: string | null;
  note: string | null;
  createdAt: string;
}

// ---- Settlement math (shared so the UI shows the same numbers the server credits) ----

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Exact comparison of decimal strings ("75552.63000000"); -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const ma = DECIMAL.exec(a);
  const mb = DECIMAL.exec(b);
  if (!ma || !mb) throw new Error(`not a decimal: ${ma ? b : a}`);
  const scale = Math.max(ma[3]?.length ?? 0, mb[3]?.length ?? 0);
  const big = (m: RegExpExecArray) => {
    const v = BigInt(`${m[2]}${(m[3] ?? '').padEnd(scale, '0')}`);
    return m[1] === '-' ? -v : v;
  };
  const x = big(ma);
  const y = big(mb);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** call wins if close > open, put wins if close < open, equal prices are a void (stake back). */
export function decideOutcome(direction: Direction, openPrice: string, closePrice: string): 'won' | 'lost' | 'void' {
  const cmp = compareDecimal(closePrice, openPrice);
  if (cmp === 0) return 'void';
  return (direction === 'call') === cmp > 0 ? 'won' : 'lost';
}

/** Profit on a win, rounded down to the cent. */
export function profitCents(stakeCents: number, payoutPct: number): number {
  return Math.floor((stakeCents * payoutPct) / 100);
}

/** Amount credited at settlement: stake + profit on a win, the stake on a void, nothing on a loss. */
export function creditCents(status: 'won' | 'lost' | 'void', stakeCents: number, payoutPct: number): number {
  if (status === 'won') return stakeCents + profitCents(stakeCents, payoutPct);
  if (status === 'void') return stakeCents;
  return 0;
}

/** One tradeable asset as served by `GET /api/assets`. */
export type AssetKind = 'market' | 'otc';
export const ASSET_CATEGORIES = ['crypto', 'stocks', 'synthetic', 'forex'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export interface AssetView {
  id: number;
  symbol: string;
  display: string;
  payoutPct: number;
  /** market: Binance price. otc: generated by the platform, open 24/7. */
  kind: AssetKind;
  /** Group in the asset picker. */
  category: AssetCategory;
}

export interface OrderLimitsView {
  minStakeCents: number;
  maxStakeCents: number;
  durationsSec: readonly number[];
}

export interface AssetsResponse {
  assets: AssetView[];
  limits: OrderLimitsView;
}

// ---- Trade analytics ("Análises de operações") ----

/** Result filter: all settled orders, or only wins, losses or ties (void = stake returned). */
export const STATS_RESULTS = ['all', 'won', 'lost', 'void'] as const;
export type StatsResult = (typeof STATS_RESULTS)[number];

/** Longest range one request may cover. */
export const STATS_MAX_DAYS = 370;

const isoInstant = z.iso.datetime({ offset: true, error: 'Data inválida.' });

/** Settled orders opened in [from, to), grouped by day in the user's time zone. */
export const OrderStatsQuery = z
  .object({
    account: AccountKindSchema.default('real'),
    result: z.enum(STATS_RESULTS, 'Tipo inválido.').default('all'),
    from: isoInstant,
    to: isoInstant,
    /** IANA zone used to cut days for the daily series, e.g. America/Sao_Paulo. */
    tz: z
      .string()
      .max(64)
      .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/, 'Fuso horário inválido.')
      .default('UTC'),
  })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: 'A data final deve ser depois da inicial.', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= STATS_MAX_DAYS * 86_400_000, {
    message: `Escolha um período de até ${STATS_MAX_DAYS} dias.`,
    path: ['from'],
  });
export type OrderStatsQuery = z.infer<typeof OrderStatsQuery>;

export interface OrderStatsDay {
  /** YYYY-MM-DD in the requested time zone. */
  day: string;
  netCents: number;
  /** Running total since the start of the range. */
  cumulativeCents: number;
  orders: number;
}

export interface OrderStats {
  total: number;
  won: number;
  lost: number;
  void: number;
  /** Net result: profit on wins minus stakes lost. */
  profitCents: number;
  /** Best and worst single order (net). Null with no orders. */
  bestCents: number | null;
  worstCents: number | null;
  /** Wins over decided orders (wins + losses), 0..100. Null when nothing was decided. */
  winRatePct: number | null;
  /** Total staked, and the largest and smallest stake. */
  volumeCents: number;
  maxStakeCents: number | null;
  minStakeCents: number | null;
  daily: OrderStatsDay[];
}

/** Settled orders for the analytics table, same filters as the stats. */
export const ListOrderHistoryQuery = z.object({
  account: AccountKindSchema.default('real'),
  result: z.enum(STATS_RESULTS, 'Tipo inválido.').default('all'),
  from: isoInstant,
  to: isoInstant,
  cursor: z.string().max(200).optional(),
  limit,
});
export type ListOrderHistoryQuery = z.infer<typeof ListOrderHistoryQuery>;

// ---- Candle-aligned expiry ----

/**
 * Orders close at the end of a clock candle the size of their duration (1, 5, 15 or 30 min,
 * aligned to UTC like the chart). Entering with this much time or less left in the candle
 * is a late entry: the order runs through the next candle and closes at its end.
 */
export const LATE_ENTRY_MS = 50_000;

export interface CandleExpiry {
  /** End of the candle the entry falls in. */
  candleEndsAt: number;
  /** True when the entry is in the last LATE_ENTRY_MS of the candle (the yellow window). */
  late: boolean;
  /** When the order settles: this candle's end, or the next candle's end on a late entry. */
  closesAt: number;
}

export function candleExpiry(atMs: number, durationSec: number): CandleExpiry {
  const size = durationSec * 1000;
  const candleEndsAt = Math.floor(atMs / size) * size + size;
  const late = candleEndsAt - atMs <= LATE_ENTRY_MS;
  return { candleEndsAt, late, closesAt: late ? candleEndsAt + size : candleEndsAt };
}
