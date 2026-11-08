import { OTC_OVERRIDE_LANDING_MS, OTC_OVERRIDE_RELEASE_MS, scheduledTarget, type OtcOverrideWire } from '@traderoom/shared';
import { cryptoNormal, type NormalSource } from './otc.js';
import { OverridePath } from './override-path.js';
import type { Tick } from './types.js';

/** Grid when the asset has no price_decimals (the API refuses those overrides; this is a safety net). */
export const PRICE_OVERRIDE_FALLBACK_DECIMALS = 8;

export interface PriceOverrideOptions {
  /** assets.price_decimals: the grid the target was rounded to and the chart draws. */
  decimals?: number;
  /** Realized volatility per √s (log-price), the ramp noise cap; null/absent: no cap. */
  volPerSqrtS?: number | null;
  normal?: NormalSource;
  /** Scheduled mode: called once with the target when it freezes (half the ramp). */
  onTarget?(price: string): void;
  /**
   * Scheduled mode: otc_overrides.target_price, frozen by an earlier run (the ws restarted inside the
   * candle). Always preferred: the candle closes where the mark points.
   */
  persistedTarget?: number | null;
}

type Schedule = NonNullable<OtcOverrideWire['schedule']>;

/** Decimal places of a provider price string ("76012.34000000" → 8). */
function decimalsOf(price: string): number {
  const dot = price.indexOf('.');
  return dot < 0 ? 0 : price.length - dot - 1;
}

/**
 * Override of one market asset's price for one 1m candle close. Same phases as the OTC walk, but it
 * rewrites real ticks instead of generating them:
 * - before rampStartMs: the real price, untouched;
 * - ramp: Brownian bridge (OverridePath) from the real price at the first ramp tick to the target,
 *   reaching it at holdStart - LANDING;
 * - from there to closeMs: a wobble around the target inside the hold band, on the price_decimals grid;
 * - release: eases back to the real price (τ = release/3), then it is dropped.
 * Scheduled mode (`wire.schedule`): until openMs every tick is returned raw (no `ov`), so the previous
 * candle closes on its own. The first tick from openMs resolves the target from the open (the last tick
 * before the rollover, which the relay passes); during the first half of the ramp the offset shrinks
 * if the target would sit further than max_override_pct from the real price, then it freezes.
 * `jitter: false` keeps the legacy path: deterministic easeOutCubic ramp and exactly the target in the hold.
 * Only price and value change; ts and recvMs stay the real tick's, so staleness checks still see
 * the real feed. The text keeps the provider's format (8 decimals): only the value sits on the grid.
 */
export class PriceOverride {
  readonly id: string | undefined;
  private target: number;
  private readonly wireTarget: number;
  private readonly schedule: Schedule | null;
  /** Scheduled: the body in ticks after the clamp (only shrinks). */
  private ticks = 0;
  /** Scheduled: the reference open, set at the first ramp tick. */
  private open: number | null = null;
  private frozen: boolean;
  private readonly freezeMs: number;
  private readonly onTarget: ((price: string) => void) | undefined;
  private readonly persisted: number | null;
  private readonly rampStartMs: number;
  private readonly landMs: number;
  private readonly closeMs: number;
  private readonly releaseEndMs: number;
  private readonly jitter: boolean;
  private readonly decimals: number;
  private readonly volPerSqrtS: number | null;
  private readonly normal: NormalSource;
  private targetX: number;
  /** Real price at the first ramp tick (legacy path). */
  private x0: number | null = null;
  /** Ramp + hold (jitter path), born at the first ramp tick. */
  private path: OverridePath | null = null;
  /** Last price shown, for the release easing. */
  private shown: number | null = null;
  private lastMs: number;
  private finished: boolean;

  constructor(
    wire: OtcOverrideWire,
    nowMs: number,
    opts: PriceOverrideOptions = {},
  ) {
    this.id = wire.id;
    this.schedule = wire.schedule ?? null;
    this.wireTarget = Number(wire.targetPrice);
    this.target = this.wireTarget;
    const holdStartMs = wire.closeMs - wire.holdMs;
    // Never in the past: read late, the ramp would start half done and jump.
    this.rampStartMs = Math.min(Math.max(wire.rampStartMs, nowMs), holdStartMs);
    this.landMs = Math.max(this.rampStartMs, holdStartMs - OTC_OVERRIDE_LANDING_MS);
    this.closeMs = wire.closeMs;
    this.releaseEndMs = wire.closeMs + wire.releaseMs;
    this.jitter = wire.jitter ?? true;
    this.decimals = opts.decimals ?? PRICE_OVERRIDE_FALLBACK_DECIMALS;
    this.volPerSqrtS = opts.volPerSqrtS ?? null;
    this.normal = opts.normal ?? cryptoNormal();
    this.targetX = Math.log(this.target);
    this.lastMs = nowMs;
    this.onTarget = opts.onTarget;
    const persisted = opts.persistedTarget ?? null;
    this.persisted = this.schedule && persisted !== null && persisted > 0 ? persisted : null;
    this.freezeMs = this.rampStartMs + (this.landMs - this.rampStartMs) / 2;
    this.frozen = this.schedule === null;
    // Scheduled: the target is unknown until the open, so only the wire's numbers are checked.
    const valid = this.schedule ? this.schedule.ticks > 0 : this.target > 0;
    this.finished = !valid || nowMs >= this.releaseEndMs;
  }

  /**
   * The close this override aims at. Immediate mode: the wire's price. Scheduled, in this order:
   * the persisted target_price (an earlier run froze it); open × (1 ± ticks × tickPct) on the grid,
   * with the body after the clamp, when the open (bucketOpen) is known; else the same from `firstTick`.
   */
  resolveTarget(openPrice: number | undefined, firstTick = openPrice): number {
    if (!this.schedule) return this.wireTarget;
    if (this.persisted !== null) return this.persisted;
    const from = openPrice ?? firstTick;
    if (from === undefined) return Number.NaN;
    return this.fromOpen(from);
  }

  private fromOpen(open: number): number {
    const s = this.schedule as Schedule;
    return scheduledTarget(open, s.direction, this.ticks || s.ticks, this.decimals);
  }

  /** Scheduled: the booked candle's open, epoch ms (null in immediate mode). */
  get openMs(): number | null {
    return this.schedule?.openMs ?? null;
  }

  /** Scheduled and not resolved yet, with the candle already open: the relay must pass the open. */
  needsOpen(nowMs: number): boolean {
    return this.schedule !== null && this.open === null && !this.finished && nowMs >= this.rampStartMs && nowMs <= this.closeMs;
  }

  /** Current target (NaN for a scheduled override before its open). */
  get targetPrice(): number {
    return this.target;
  }

  /** Scheduled: the body in ticks now (after the clamp); 0 before the open. */
  get bodyTicks(): number {
    return this.ticks;
  }

  /** Scheduled: the hold band stays under the body, so the close keeps the candle's color. */
  private maxBand(): number | undefined {
    return this.schedule ? Math.max(0, this.ticks - 1) : undefined;
  }

  private setTarget(target: number): void {
    this.target = target;
    this.targetX = Math.log(target);
    this.path?.setTarget(this.targetX, this.maxBand());
  }

  /** First half of the ramp: shrink the body until the target is within max_override_pct of `real`. */
  private clamp(real: number): void {
    const s = this.schedule;
    if (!s || this.open === null) return;
    const tick = 10 ** -this.decimals;
    const maxFrac = s.maxOverridePct / 100;
    const room = s.direction === 'up' ? (real * (1 + maxFrac) - this.open) / tick : (this.open - real * (1 - maxFrac)) / tick;
    // At least one tick: the candle keeps its color even when the real price alone is past the limit.
    const allowed = Math.max(1, Math.floor(room + 1e-9));
    if (allowed >= this.ticks) return;
    this.ticks = allowed;
    this.setTarget(this.fromOpen(this.open));
  }

  /** Scheduled: resolves at the first ramp tick, clamps in the first half, then freezes. */
  private steer(real: number, nowMs: number, openPrice: number | undefined): void {
    const s = this.schedule;
    if (!s || this.frozen) return;
    if (this.open === null) {
      if (this.persisted !== null) {
        // Already frozen by an earlier run: no clamp, nothing to save. Without the open the body is
        // unknown, so the hold is exact (band 0); with it, the band stays under the body as usual.
        this.open = openPrice ?? real;
        this.ticks = openPrice === undefined ? 1 : Math.max(1, Math.round(Math.abs(this.persisted - openPrice) / 10 ** -this.decimals));
        this.setTarget(this.resolveTarget(openPrice, real));
        this.frozen = true;
        return;
      }
      this.open = openPrice ?? real;
      this.ticks = s.ticks;
      this.setTarget(this.resolveTarget(openPrice, real));
    }
    if (nowMs < this.freezeMs) {
      this.clamp(real);
      return;
    }
    this.frozen = true;
    this.onTarget?.(this.target.toFixed(this.decimals));
  }

  /** True once the release is over: the relay drops it. */
  get done(): boolean {
    return this.finished;
  }

  /** `openPrice`: scheduled mode, the last tick before the rollover (the relay's bucketOpen). */
  apply(tick: Tick, nowMs: number, openPrice?: number): Tick {
    const dtS = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    if (this.finished || nowMs < this.rampStartMs) return tick;
    if (nowMs >= this.releaseEndMs) {
      this.finished = true;
      return tick;
    }

    const real = tick.value;
    if (nowMs <= this.closeMs) this.steer(real, nowMs, openPrice);
    let price: number;
    // closeMs itself still belongs to the hold: a snapshot stamped exactly at expiry must see the target.
    if (nowMs > this.closeMs) {
      // Installed after the close: never changed a price, nothing to hand back.
      if (this.shown === null) return tick;
      const from = this.shown;
      const k = 1 - Math.exp(-dtS / (OTC_OVERRIDE_RELEASE_MS / 1000 / 3));
      price = from + (real - from) * k;
    } else if (this.jitter) {
      // x0 is the real price at this, the first ramp tick, which is shown as is. startMs is kept
      // before landMs so a first tick arriving at or after it lands on the target.
      this.path ??= new OverridePath({
        x0: Math.log(real),
        targetX: this.targetX,
        startMs: Math.min(nowMs, this.landMs - 1),
        landMs: this.landMs,
        volPerSqrtS: this.volPerSqrtS,
        decimals: this.decimals,
        normal: this.normal,
        ...(this.schedule ? { maxBandTicks: Math.max(0, this.ticks - 1) } : {}),
      });
      price = Number(Math.exp(this.path.step(nowMs)).toFixed(this.decimals));
    } else if (nowMs >= this.landMs) {
      price = this.target;
    } else {
      this.x0 ??= real;
      const span = Math.max(1, this.landMs - this.rampStartMs);
      const p = Math.min(1, Math.max(0, (nowMs - this.rampStartMs) / span));
      const eased = 1 - (1 - p) ** 3;
      price = this.x0 + (this.target - this.x0) * eased;
    }
    this.shown = price;
    const text = price.toFixed(Math.max(decimalsOf(tick.price), this.jitter ? this.decimals : 0));
    return { ...tick, price: text, value: Number(text), realPrice: tick.price, ov: this.id };
  }
}
