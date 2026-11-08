import { z } from 'zod';
import { CANDLE_INTERVALS, type CandleInterval } from './market.js';

/** Chave única do override ativo (um por vez). */
export const OTC_OVERRIDE_KEY = 'otc:override';
/** Menos que isso até o fechamento: o alvo vai para o próximo candle. */
export const OTC_OVERRIDE_MIN_LEAD_MS = 6000;
/** O alvo fica parado desde close-hold: 3 snapshots de 1 s, com folga para um ser pulado. */
export const OTC_OVERRIDE_HOLD_MS = 3000;
/** Tempo de volta ao preço base depois do fechamento. */
export const OTC_OVERRIDE_RELEASE_MS = 2000;
export const OTC_OVERRIDE_RAMP_DEFAULT_MS = 25_000;
// 25 s, not 8: the drift-to-noise ratio of the bridge is (1/SIGMA_FACTOR)·√(dt/T). At 8 s it is 2.5
// and almost no tick goes against the direction, so the ramp looks drawn. At 25 s it is ~1.4 and the
// candle wobbles. Lower this and the ramp goes straight again.
/**
 * The ramp reaches the target this long before the hold starts. Snapshots see the newest tick,
 * which can be one OTC tick (500 ms) plus one conflation window (200 ms) old: landing early keeps
 * every snapshot taken in the hold exactly on the target.
 */
export const OTC_OVERRIDE_LANDING_MS = 1000;

/** Duração de cada intervalo; o candle é alinhado a múltiplos disso desde a época (UTC). */
export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** O candle `[openMs, closeMs)` que contém `nowMs`. */
export function candleBucket(nowMs: number, stepMs: number): { openMs: number; closeMs: number } {
  const openMs = Math.floor(nowMs / stepMs) * stepMs;
  return { openMs, closeMs: openMs + stepMs };
}

/**
 * When the ramp starts: early enough for `rampMs` of movement, the landing and the hold before the
 * close, and never in the past. API, ws, UI and the manual script all use this one rule.
 */
export function otcOverrideRampStartMs(nowMs: number, closeMs: number, rampMs = OTC_OVERRIDE_RAMP_DEFAULT_MS): number {
  return Math.max(nowMs, closeMs - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS - rampMs);
}

export type OtcOverridePhase = 'ramp' | 'hold' | 'release';

/** Fase em `nowMs`; antes de `rampStartMs` o preço ainda é natural, mas a fase já é 'ramp'. */
export function otcOverridePhase(nowMs: number, closeMs: number, holdMs = OTC_OVERRIDE_HOLD_MS): OtcOverridePhase {
  if (nowMs < closeMs - holdMs) return 'ramp';
  if (nowMs <= closeMs) return 'hold';
  return 'release';
}

/** Scheduled mode: how far ahead a candle can be booked. */
export const OTC_OVERRIDE_SCHEDULE_HORIZON_MS = 60 * 60_000;
/** Scheduled mode: smallest body, in price ticks (10^-price_decimals), and its step. */
export const OTC_OVERRIDE_MIN_TICKS = 10;
export const OTC_OVERRIDE_TICKS_STEP = 5;

export const OVERRIDE_DIRECTIONS = ['up', 'down'] as const;
export type OverrideDirection = (typeof OVERRIDE_DIRECTIONS)[number];

/**
 * One price tick as a fraction of the open: the unit of the scheduled body. `decimals` is the
 * asset's price grid (price_decimals).
 */
export function overrideTickPct(openPrice: number, decimals: number): number {
  return 10 ** -decimals / openPrice;
}

/**
 * Scheduled target: open × (1 ± ticks × tickPct), on the price grid. With tickPct from
 * overrideTickPct this is open ± ticks price ticks.
 */
export function scheduledTarget(openPrice: number, direction: OverrideDirection, ticks: number, decimals: number): number {
  const sign = direction === 'up' ? 1 : -1;
  return Number((openPrice * (1 + sign * ticks * overrideTickPct(openPrice, decimals))).toFixed(decimals));
}

export const PRICE_OVERRIDE_KINDS = ['otc', 'market'] as const;
export type PriceOverrideKind = (typeof PRICE_OVERRIDE_KINDS)[number];

/** O que o ws lê do Redis a cada tick. */
export const OtcOverrideWire = z.object({
  /** otc_overrides.id; the relay stamps it on every price it changes. */
  id: z.string().optional(),
  /** Absent means 'otc' (payloads written before market overrides existed). */
  kind: z.enum(PRICE_OVERRIDE_KINDS).optional(),
  /**
   * Absent means true. Market: small noise on the ramp. OTC: Brownian-bridge ramp and a wobble around the
   * target in the hold (close within a few ticks of it); false keeps the easeOut ramp and the exact, flat hold.
   */
  jitter: z.boolean().optional(),
  symbol: z.string(),
  /** Absent only with `schedule`: the ws resolves the target at the candle open. */
  targetPrice: z.string().optional(),
  basePrice: z.string(),
  /**
   * Scheduled mode (market, 1m): the target is open ± ticks, with open the last tick before the
   * rollover to `openMs`. Before openMs nothing is touched; rampStartMs is openMs.
   */
  schedule: z
    .object({
      openMs: z.number().int(),
      direction: z.enum(OVERRIDE_DIRECTIONS),
      ticks: z.number().int().positive(),
      /** assets.max_override_pct: the target never sits further than this from the real price. */
      maxOverridePct: z.number().positive(),
    })
    .optional(),
  closeMs: z.number().int(),
  rampStartMs: z.number().int(),
  holdMs: z.number().int(),
  releaseMs: z.number().int(),
});
export type OtcOverrideWire = z.infer<typeof OtcOverrideWire>;

export function parseOtcOverride(raw: string | null): OtcOverrideWire | null {
  if (!raw) return null;
  try {
    const p = OtcOverrideWire.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export const OtcOverrideScheduleInput = z.object({
  /** Candle open, epoch ms (absolute, not a local time). */
  atMs: z
    .number('Informe o horário.')
    .int('Horário inválido.')
    .refine((v) => v % CANDLE_INTERVAL_MS['1m'] === 0, 'Horário inválido: tem que ser o início de um minuto.'),
  direction: z.enum(OVERRIDE_DIRECTIONS, 'Direção inválida.'),
  ticks: z
    .number('Informe o tamanho do corpo.')
    .int('Ticks inválidos.')
    .min(OTC_OVERRIDE_MIN_TICKS, `O corpo mínimo é ${OTC_OVERRIDE_MIN_TICKS} ticks.`)
    .multipleOf(OTC_OVERRIDE_TICKS_STEP, `O corpo é em múltiplos de ${OTC_OVERRIDE_TICKS_STEP} ticks.`),
});
export type OtcOverrideScheduleInput = z.infer<typeof OtcOverrideScheduleInput>;

export const OtcOverrideInput = z
  .object({
    assetId: z.number().int().positive('Ativo inválido.'),
    interval: z.enum(CANDLE_INTERVALS, 'Intervalo inválido.'),
    /** Immediate mode. Ignored with `schedule`. */
    targetPrice: z.number('Informe o preço alvo.').positive('Informe o preço alvo.').finite('Preço alvo inválido.').optional(),
    rampMs: z.number().int().min(500).max(60_000).default(OTC_OVERRIDE_RAMP_DEFAULT_MS),
    /** Aplica no candle seguinte mesmo que ainda haja tempo. */
    nextCandle: z.boolean().default(false),
    /** Scheduled mode (market assets, 1m): a future candle, a color and a body size. */
    schedule: OtcOverrideScheduleInput.optional(),
  })
  .refine((v) => v.schedule !== undefined || v.targetPrice !== undefined, { message: 'Informe o preço alvo.', path: ['targetPrice'] });
export type OtcOverrideInput = z.infer<typeof OtcOverrideInput>;

export interface OtcOverrideView {
  id: string;
  kind: PriceOverrideKind;
  assetId: number;
  symbol: string;
  display: string;
  /** Casas decimais do ativo (otc_decimals, ou price_decimals no mercado). */
  decimals: number;
  intervalSec: number;
  /** Null for a scheduled override until the ws resolves it at the candle open. */
  targetPrice: number | null;
  basePrice: number;
  /** Set for the scheduled mode. */
  schedule: { direction: OverrideDirection; ticks: number } | null;
  /** Preço atual em `px:<symbol>`, ou null se o feed não tem cotação. */
  currentPrice: number | null;
  candleOpenMs: number;
  candleCloseMs: number;
  /** Até aqui o preço é natural; daí até holdStartMs, rampa. */
  rampStartMs: number;
  holdStartMs: number;
  /** O override termina aqui: o preço já voltou ao caminho natural. */
  releaseEndMs: number;
  /** Restante até o fechamento (negativo no release). */
  remainingMs: number;
  phase: OtcOverridePhase;
  createdBy: string;
  createdAt: string;
}

/** Ativo habilitado que pode receber override (OTC ou mercado). */
export interface OtcOverrideAsset {
  id: number;
  kind: PriceOverrideKind;
  symbol: string;
  display: string;
  decimals: number;
  /** Market only: largest gap from the current price, in percent. */
  maxOverridePct: number | null;
}

/** GET /api/market/override?symbol= — whether the platform is setting this asset's price now. */
export interface PublicOverrideState {
  active: boolean;
  /** When the price is back to normal (release end), epoch ms. */
  untilMs: number | null;
  targetPrice: number | null;
}

/** GET /api/admin/otc-override */
export interface OtcOverrideState {
  override: OtcOverrideView | null;
  assets: OtcOverrideAsset[];
  /** Relógio do servidor, epoch ms, para a contagem regressiva. */
  serverNowMs: number;
}
