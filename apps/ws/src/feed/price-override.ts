import { OTC_OVERRIDE_LANDING_MS, OTC_OVERRIDE_RELEASE_MS, type OtcOverrideWire } from '@traderoom/shared';
import type { Tick } from './types.js';

/** Ramp noise, relative to the price (1 bp), fading to zero on arrival. */
const JITTER_REL = 0.0001;

/** Decimal places of a provider price string ("76012.34000000" → 8). */
function decimalsOf(price: string): number {
  const dot = price.indexOf('.');
  return dot < 0 ? 0 : price.length - dot - 1;
}

/**
 * Override of one market asset's price for one 1m candle close. Same phases as the OTC walk, but it
 * rewrites real ticks instead of generating them:
 * - before rampStartMs: the real price, untouched;
 * - ramp: deterministic easeOutCubic from the real price at the first ramp tick to the target;
 * - from holdStart - LANDING to closeMs: exactly the target;
 * - release: eases back to the real price (τ = release/3), then it is dropped.
 * Only price and value change; ts and recvMs stay the real tick's, so staleness checks still see
 * the real feed.
 */
export class PriceOverride {
  readonly id: string | undefined;
  private readonly target: number;
  private readonly rampStartMs: number;
  private readonly landMs: number;
  private readonly closeMs: number;
  private readonly releaseEndMs: number;
  private readonly jitter: boolean;
  /** Real price at the first ramp tick. */
  private x0: number | null = null;
  /** Last price shown, for the release easing. */
  private shown: number | null = null;
  private lastMs: number;
  private finished: boolean;

  constructor(
    wire: OtcOverrideWire,
    nowMs: number,
    private readonly random: () => number = Math.random,
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
    } else if (nowMs >= this.landMs) {
      price = this.target;
    } else {
      this.x0 ??= real;
      const span = Math.max(1, this.landMs - this.rampStartMs);
      const p = Math.min(1, Math.max(0, (nowMs - this.rampStartMs) / span));
      const eased = 1 - (1 - p) ** 3;
      price = this.x0 + (this.target - this.x0) * eased;
      if (this.jitter) price += (this.random() * 2 - 1) * JITTER_REL * real * (1 - p);
    }
    this.shown = price;
    const text = price.toFixed(decimalsOf(tick.price));
    return { ...tick, price: text, value: Number(text), realPrice: tick.price, ov: this.id };
  }
}
