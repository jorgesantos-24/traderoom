import type { NormalSource } from './otc.js';

/**
 * Shape of an override's price path (OTC): Brownian-bridge ramp to the target, then a small
 * mean-reverting wobble around it until the close, so the candle never looks frozen.
 *
 * All state is log-price. Times are wall-clock ms; rates are per second.
 */

/** Ramp noise relative to the move: σ ≤ SIGMA_FACTOR·|target − x0| / √(ramp seconds). */
export const SIGMA_FACTOR = 0.1;
/** Hold band: this fraction of the body |target − x0| (in price), never under BAND_MIN_TICKS ticks. */
export const BAND_FRACTION = 0.1;
export const BAND_MIN_TICKS = 2;

/** Hold: half-life of the pull back to the target, seconds. */
const HOLD_HALF_LIFE_S = 1;

export interface OverridePathInit {
  /** Log-price where the ramp starts (the price shown at the first tick of the ramp). */
  x0: number;
  targetX: number;
  startMs: number;
  /** The ramp reaches the target here; the hold runs from here to the close. */
  landMs: number;
  /** Asset volatility per √second (log-price): a cap on the ramp noise. null: no cap (body-derived σ only). */
  volPerSqrtS: number | null;
  decimals: number;
  normal: NormalSource;
}

export class OverridePath {
  private x: number;
  private lastMs: number;
  private landed = false;
  /** Hold position, whole ticks from the target (what the client sees). */
  private k = 0;
  /** Last shown ramp prices in ticks (newest last, at most 3), starting with x0. */
  private readonly shown: number[];
  private readonly x0: number;
  private readonly targetX: number;
  private readonly landMs: number;
  private readonly sigma: number;
  private readonly dir: number;
  private readonly normal: NormalSource;
  private readonly tick: number;
  private readonly target: number;
  /** Hold band in whole ticks. */
  readonly bandTicks: number;

  constructor(init: OverridePathInit) {
    this.x = init.x0;
    this.x0 = init.x0;
    this.targetX = init.targetX;
    this.lastMs = init.startMs;
    this.landMs = init.landMs;
    this.normal = init.normal;
    this.tick = 10 ** -init.decimals;
    this.target = Math.exp(init.targetX);
    this.dir = Math.sign(init.targetX - init.x0);
    this.shown = [Math.round(Math.exp(init.x0) / this.tick)];

    const spanS = Math.max(1e-3, (init.landMs - init.startMs) / 1000);
    const bodySigma = (SIGMA_FACTOR * Math.abs(init.targetX - init.x0)) / Math.sqrt(spanS);
    this.sigma = init.volPerSqrtS === null ? bodySigma : Math.min(init.volPerSqrtS, bodySigma);

    const body = Math.abs(this.target - Math.exp(init.x0));
    const ticks = Math.round((BAND_FRACTION * body) / this.tick);
    this.bandTicks = Math.max(BAND_MIN_TICKS, ticks);
  }

  /** Hold band in price units (± around the target). */
  get bandPrice(): number {
    return this.bandTicks * this.tick;
  }

  /** Advances to `atMs` and returns the log-price. */
  step(atMs: number): number {
    if (atMs <= this.lastMs) return this.x;
    const prevMs = this.lastMs;
    this.lastMs = atMs;
    const dtS = (atMs - prevMs) / 1000;
    if (!this.landed) this.bridge(dtS, prevMs, atMs);
    else this.hold(dtS);
    return this.x;
  }

  /** Brownian bridge from the previous tick to (landMs, targetX). */
  private bridge(dtS: number, prevMs: number, atMs: number): void {
    // Time left measured from the previous tick: then dt/remain is exact for the bridge.
    const remainS = (this.landMs - prevMs) / 1000;
    if (remainS <= 0 || atMs >= this.landMs) {
      this.x = this.targetX;
      this.landed = true;
      this.k = 0;
      return;
    }
    const f = dtS / remainS;
    const mean = this.x + (this.targetX - this.x) * f;
    const sd = this.sigma * Math.sqrt(dtS * (1 - f));
    // Shown prices, in ticks. A step that would put 4 shown ticks on one line (equal steps within a
    // tick) is redrawn: rare by chance, but a straight run is what makes a path look drawn.
    const shown = (x: number) => Math.round(Math.exp(x) / this.tick);
    let next = mean;
    for (let attempt = 0; attempt < 8; attempt++) {
      next = this.reflectAtStart(mean + sd * this.normal());
      if (!this.collinear(shown(next))) break;
    }
    this.x = next;
    this.shown.push(shown(next));
    if (this.shown.length > 3) this.shown.shift();
  }

  /** Never back past the start against the direction: reflect around x0, 1 tick of slack. */
  private reflectAtStart(x: number): number {
    if (this.dir === 0) return x;
    const barrier = this.x0 - this.dir * (this.tick / Math.exp(this.x0));
    return this.dir * (x - barrier) < 0 ? 2 * barrier - x : x;
  }

  /** Would `next` make the last three shown ticks plus it one straight line? */
  private collinear(next: number): boolean {
    const [a, b, c] = this.shown;
    if (a === undefined || b === undefined || c === undefined) return false;
    const d1 = b - a;
    const d2 = c - b;
    const d3 = next - c;
    return Math.abs(d2 - d1) <= 1 && Math.abs(d3 - d2) <= 1;
  }

  /** OU around the target in log-price, reflected at the band; every tick shows a new price. */
  private hold(dtS: number): void {
    const bandX = (this.bandTicks * this.tick) / this.target;
    const theta = Math.LN2 / HOLD_HALF_LIFE_S;
    // Stationary sd ≈ half the band.
    const s = (bandX / 2) * Math.sqrt(2 * theta);
    const z = this.normal();
    let y = this.x - this.targetX;
    y += -theta * y * dtS + s * Math.sqrt(dtS) * z;
    y = reflect(y, bandX);

    let k = Math.round((this.target * Math.expm1(y)) / this.tick);
    k = Math.max(-this.bandTicks, Math.min(this.bandTicks, k));
    if (k === this.k) {
      // Same tick as before: move one, the way the noise pushed, bouncing off the band edge.
      const d = z >= 0 ? 1 : -1;
      k = Math.abs(k + d) <= this.bandTicks ? k + d : k - d;
    }
    this.k = k;
    // Snap the state to the shown tick so the next step starts from what clients saw.
    this.x = Math.log(this.target + k * this.tick);
  }
}

/** Reflects y into [-b, b] (folds repeatedly for steps larger than the band). */
function reflect(y: number, b: number): number {
  if (b <= 0) return 0;
  const w = 4 * b;
  let u = (((y + b) % w) + w) % w;
  if (u > 2 * b) u = w - u;
  return u - b;
}
