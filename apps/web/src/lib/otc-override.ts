import {
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_RAMP_DEFAULT_MS,
  otcOverrideRampStartMs,
  scheduledTarget,
  type Candle,
  type OverrideDirection,
} from '@traderoom/shared';

export type Ohlc = Pick<Candle, 't' | 'o' | 'h' | 'l' | 'c'>;

/**
 * Candles with the live price folded into the current one (`openMs`): updates it when the server
 * already has it, starts it from the previous close when it does not. Keeps at most `max`.
 */
export function withLiveCandle(candles: readonly Ohlc[], price: number | null, openMs: number, max = 60): Ohlc[] {
  const out = candles.filter((c) => c.t <= openMs).map((c) => ({ ...c }));
  const last = out.at(-1);
  if (price !== null && Number.isFinite(price)) {
    if (last && last.t === openMs) {
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
    } else {
      const o = last?.c ?? price;
      out.push({ t: openMs, o, h: Math.max(o, price), l: Math.min(o, price), c: price });
    }
  }
  return out.slice(-max);
}

/** The current candle as it will close if the target holds: close on the target, wicks stretched to reach it. */
export function editedCandle(c: Ohlc, target: number): Ohlc {
  return { t: c.t, o: c.o, h: Math.max(c.h, c.o, target), l: Math.min(c.l, c.o, target), c: target };
}

export interface PriceScale {
  min: number;
  max: number;
}

/** Range over every candle and extra price, with `pad` of it as margin on each side; never zero-height. */
export function priceScale(candles: readonly Ohlc[], extra: ReadonlyArray<number | null> = [], pad = 0.12): PriceScale | null {
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    min = Math.min(min, c.l);
    max = Math.max(max, c.h);
  }
  for (const p of extra) {
    if (p === null || !Number.isFinite(p)) continue;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const span = max - min || Math.abs(max) * 0.002 || 1;
  return { min: min - span * pad, max: max + span * pad };
}

export const priceToY = (s: PriceScale, top: number, height: number, p: number) => top + ((s.max - p) / (s.max - s.min)) * height;
export const yToPrice = (s: PriceScale, top: number, height: number, y: number) => s.max - ((y - top) / height) * (s.max - s.min);

export function roundTo(price: number, decimals: number): number {
  return Number(price.toFixed(decimals));
}

/** "Nice" grid step for about `lines` lines over the range. */
export function gridStep(s: PriceScale, lines = 6): number {
  const raw = (s.max - s.min) / lines;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export interface RampPlan {
  /** When the price starts moving (server rule: max(now, close − hold − landing − ramp)). */
  rampStartMs: number;
  holdStartMs: number;
  /** How long the ramp has to cover the distance (it lands OTC_OVERRIDE_LANDING_MS before the hold). */
  rampMs: number;
}

export function rampPlan(nowMs: number, closeMs: number, rampMs = OTC_OVERRIDE_RAMP_DEFAULT_MS): RampPlan {
  const holdStartMs = closeMs - OTC_OVERRIDE_HOLD_MS;
  const rampStartMs = otcOverrideRampStartMs(nowMs, closeMs, rampMs);
  return { rampStartMs, holdStartMs, rampMs: Math.max(0, holdStartMs - OTC_OVERRIDE_LANDING_MS - rampStartMs) };
}

/** Average speed the ramp needs to go from `from` to `to`, per second. */
export function requiredSpeed(from: number, to: number, rampMs: number): { pricePerSec: number; pctPerSec: number } | null {
  if (!(rampMs > 0) || !(from > 0)) return null;
  const pricePerSec = (to - from) / (rampMs / 1000);
  return { pricePerSec, pctPerSec: (pricePerSec / from) * 100 };
}

export const PHASE_LABEL = { waiting: 'Aguardando rampa', ramp: 'Rampa', hold: 'Hold no alvo', release: 'Voltando ao natural' } as const;

export function phaseAt(nowMs: number, o: { rampStartMs: number; holdStartMs: number; candleCloseMs: number }): keyof typeof PHASE_LABEL {
  if (nowMs < o.rampStartMs) return 'waiting';
  if (nowMs < o.holdStartMs) return 'ramp';
  if (nowMs <= o.candleCloseMs) return 'hold';
  return 'release';
}

/**
 * "HH:MM" in the browser's time zone → the epoch ms of that minute, the next time it happens after
 * `nowMs` (today, or tomorrow if it already passed). Null when the text is not a time.
 */
export function localMinuteToEpoch(hhmm: string, nowMs: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(nowMs);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Epoch ms → "HH:MM" in the browser's time zone. */
export function epochToLocalMinute(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The scheduled candle as projected now: opens at `open`, closes `ticks` price ticks away. */
export function projectedCandle(
  open: number,
  direction: OverrideDirection,
  ticks: number,
  decimals: number,
): { o: number; c: number; offsetPct: number } {
  const c = scheduledTarget(open, direction, ticks, decimals);
  return { o: open, c, offsetPct: (Math.abs(c - open) / open) * 100 };
}
