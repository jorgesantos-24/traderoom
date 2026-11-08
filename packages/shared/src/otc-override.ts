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
export const OTC_OVERRIDE_RAMP_DEFAULT_MS = 8000;
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

/** O que o ws lê do Redis a cada tick. */
export const OtcOverrideWire = z.object({
  symbol: z.string(),
  targetPrice: z.string(),
  basePrice: z.string(),
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

export const OtcOverrideInput = z.object({
  assetId: z.number().int().positive('Ativo inválido.'),
  interval: z.enum(CANDLE_INTERVALS, 'Intervalo inválido.'),
  targetPrice: z.number('Informe o preço alvo.').positive('Informe o preço alvo.').finite('Preço alvo inválido.'),
  rampMs: z.number().int().min(500).max(60_000).default(OTC_OVERRIDE_RAMP_DEFAULT_MS),
  /** Aplica no candle seguinte mesmo que ainda haja tempo. */
  nextCandle: z.boolean().default(false),
});
export type OtcOverrideInput = z.infer<typeof OtcOverrideInput>;

export interface OtcOverrideView {
  id: string;
  assetId: number;
  symbol: string;
  display: string;
  /** Casas decimais do ativo (otc_decimals). */
  decimals: number;
  intervalSec: number;
  targetPrice: number;
  basePrice: number;
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

/** Ativo que pode receber override: OTC e habilitado. */
export interface OtcOverrideAsset {
  id: number;
  symbol: string;
  display: string;
  decimals: number;
}

/** GET /api/admin/otc-override */
export interface OtcOverrideState {
  override: OtcOverrideView | null;
  assets: OtcOverrideAsset[];
  /** Relógio do servidor, epoch ms, para a contagem regressiva. */
  serverNowMs: number;
}
