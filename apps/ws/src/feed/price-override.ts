import { OTC_OVERRIDE_LANDING_MS, OTC_OVERRIDE_RELEASE_MS, type OtcOverrideWire } from '@traderoom/shared';
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
}

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
 * `jitter: false` keeps the legacy path: deterministic easeOutCubic ramp and exactly the target in the hold.
 * Only price and value change; ts and recvMs stay the real tick's, so staleness checks still see
 * the real feed. The text keeps the provider's format (8 decimals): only the value sits on the grid.
 */
export class PriceOverride {
  readonly id: string | undefined;
  private readonly target: number;
  private readonly rampStartMs: number;
  private readonly landMs: number;
  private readonly closeMs: number;
  private readonly releaseEndMs: number;
  private readonly jitter: boolean;
  private readonly decimals: number;
  private readonly volPerSqrtS: number | null;
  private readonly normal: NormalSource;
  private readonly targetX: number;
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
    this.target = Number(wire.targetPrice);
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
    this.finished = !(this.target > 0) || nowMs >= this.releaseEndMs;
  }

  /** True once the release is over: the relay drops it. */
  get done(): boolean {
    return this.finished;
  }

  apply(tick: Tick, nowMs: number): Tick {
    const dtS = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    if (this.finished || nowMs < this.rampStartMs) return tick;
    if (nowMs >= this.releaseEndMs) {
      this.finished = true;
      return tick;
    }

    const real = tick.value;
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
