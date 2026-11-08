/**
 * Realized volatility of one market symbol, from the ticks the relay already receives.
 *
 * Quadratic variation: each pair of consecutive ticks gives r²/dt (r = log return, dt in seconds),
 * and an EWMA of that is the variance per second, so ticks at irregular intervals weigh by the time
 * they cover. The decay is by time (half-life VOL_HALF_LIFE_S), not by tick count: a busy symbol and
 * a quiet one look back over the same horizon.
 *
 * It only feeds a cap (min(vol, body-derived σ)) on override paths: a high estimate costs nothing,
 * a low one smooths the candle. So it errs high: the reported σ is VOL_BIAS times the EWMA.
 */

/** About one 1m candle. */
export const VOL_HALF_LIFE_S = 120;
/** Below either of these the estimate is not used (null: no cap). */
export const VOL_MIN_TICKS = 20;
export const VOL_MIN_SPAN_S = 30;
/** A single sample is limited to this many σ, so one book spike does not poison two minutes. */
export const VOL_CLAMP_SIGMAS = 4;
/** Multiplier on the reported σ (see sigma()). */
export const VOL_BIAS = 1.3;
/** Never report less than this (σ per √s), so the cap never collapses to zero. */
export const VOL_FLOOR = 1e-6;
/** Samples before the clamp starts (it needs an estimate to clamp against). */
const CLAMP_AFTER = 5;

export class RealizedVol {
  private lastPrice: number | null = null;
  private lastMs = 0;
  private firstMs = 0;
  private samples = 0;
  /** EWMA of r²/dt: variance per second, log-price. */
  private variance = 0;

  /** Feeds one real tick: `atMs` is its time, `price` its value. */
  update(price: number, atMs: number): void {
    if (!(price > 0) || !Number.isFinite(atMs)) return;
    if (this.lastPrice === null) {
      this.lastPrice = price;
      this.lastMs = atMs;
      this.firstMs = atMs;
      return;
    }
    const dtS = (atMs - this.lastMs) / 1000;
    // Same-ms (or out-of-order) ticks: keep the older anchor, the next tick's return covers both.
    if (dtS <= 0) return;
    const r = Math.log(price / this.lastPrice);
    let sample = (r * r) / dtS;
    // Clamped against at least the floor: after a flat stretch (variance 0) the estimate must still recover.
    if (this.samples >= CLAMP_AFTER) sample = Math.min(sample, VOL_CLAMP_SIGMAS ** 2 * Math.max(this.variance, VOL_FLOOR ** 2));
    const w = this.samples === 0 ? 1 : 1 - Math.exp((-dtS * Math.LN2) / VOL_HALF_LIFE_S);
    this.variance += (sample - this.variance) * w;
    this.samples++;
    this.lastPrice = price;
    this.lastMs = atMs;
  }

  /** σ per √second (log-price), or null while there is too little data to trust it. */
  sigma(): number | null {
    if (this.samples + 1 < VOL_MIN_TICKS || (this.lastMs - this.firstMs) / 1000 < VOL_MIN_SPAN_S) return null;
    // Clamping at 4σ truncates the spikes, so the estimate leans low — the direction that smooths the
    // candle. Vol only acts as a ceiling, so leaning high costs nothing.
    const sigma = Math.sqrt(this.variance) * VOL_BIAS;
    return Math.max(VOL_FLOOR, sigma);
  }
}
