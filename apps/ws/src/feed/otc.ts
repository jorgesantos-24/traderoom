import { randomFillSync } from 'node:crypto';
import type { Tick } from './types.js';

/**
 * OTC prices: a random walk we generate ourselves, for assets with no exchange behind them.
 *
 * Fairness rules (keep them):
 * - The generator only sees its own parameters and a random source. It never sees orders,
 *   positions or users, so it cannot move against anyone's trade.
 * - The random source is the OS CSPRNG, so the next move cannot be predicted from past ones.
 * - Admins set parameters (start price, volatility); they cannot set or nudge the price itself.
 */

export interface OtcParams {
  /** Long-run reference level; the price drifts around it. */
  startPrice: number;
  /** Typical move over one hour, in percent. */
  volPctHour: number;
  decimals: number;
  /**
   * Long-run trend, % per hour (synthetic Bull/Bear indices). With a trend there is no pull back to the
   * reference level. It is small next to the noise: over a 1-minute trade it shifts the odds by well under 1%.
   */
  driftPctHour?: number;
}

/** Standard normal draws. Injected in tests for repeatable paths. */
export type NormalSource = () => number;

/** Box–Muller over crypto-random bytes, buffered. */
export function cryptoNormal(): NormalSource {
  const buf = new Uint32Array(1024);
  let i = buf.length;
  let spare: number | null = null;
  const uniform = () => {
    if (i >= buf.length) {
      randomFillSync(buf);
      i = 0;
    }
    // (0, 1]: never 0, so log() is finite.
    return ((buf[i++] as number) + 1) / 4294967296;
  };
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const r = Math.sqrt(-2 * Math.log(uniform()));
    const th = 2 * Math.PI * uniform();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/** Φ(z), Abramowitz–Stegun 7.1.26 (error < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/*
 * Anything predictable is an edge for clients. At a 92% payout a strategy needs ~52.1% wins to profit,
 * so every predictable part below is sized to stay far under that on every allowed duration (30 s to 30 min).
 * test/otc.test.ts plays the obvious strategies (follow the last move, bet on the return to the
 * reference level) against these values.
 */

/**
 * Slow pull back toward the reference level, so prices do not wander off forever.
 * A month: over a 30-minute trade the pull is tiny next to the noise.
 */
const REVERSION_HALF_LIFE_S = 30 * 86_400;
/** Short trends: a small drift that changes on average this often, so charts have runs, not only noise. */
const TREND_MEAN_S = 180;
/** Trend strength relative to the noise (per second). Kept small: copying the last move must not pay. */
const TREND_SCALE = 0.02;

/**
 * One asset's path in log-price: mean-reverting walk with a slowly changing drift.
 * dx = (μ − θ·(x − a))·dt + σ·√dt·Z
 */
export class OtcWalk {
  private x: number;
  private drift = 0;
  private trendLeftS = 0;
  private params: OtcParams;

  constructor(
    params: OtcParams,
    price: number,
    private readonly normal: NormalSource,
  ) {
    this.params = params;
    this.x = Math.log(price);
  }

  setParams(p: OtcParams): void {
    this.params = p;
  }

  get price(): number {
    return Math.exp(this.x);
  }

  /** Volatility per √second, from the hourly figure. */
  private sigma(): number {
    return this.params.volPctHour / 100 / Math.sqrt(3600);
  }

  /** Advances `dtS` seconds and returns the new (unrounded) price. */
  step(dtS: number): number {
    if (dtS <= 0) return this.price;
    const sigma = this.sigma();
    this.trendLeftS -= dtS;
    if (this.trendLeftS <= 0) {
      // Exponential duration (mean TREND_MEAN_S): normal → uniform through its CDF, then inverse exponential.
      const u = Math.min(0.999999, Math.max(1e-6, normalCdf(this.normal())));
      this.trendLeftS = -TREND_MEAN_S * Math.log(1 - u) + 20;
      this.drift = this.normal() * sigma * TREND_SCALE;
    }
    const trend = (this.params.driftPctHour ?? 0) / 100 / 3600;
    const theta = trend === 0 ? Math.LN2 / REVERSION_HALF_LIFE_S : 0;
    const anchor = Math.log(this.params.startPrice);
    this.x += (trend + this.drift - theta * (this.x - anchor)) * dtS + sigma * Math.sqrt(dtS) * this.normal();
    return this.price;
  }

  /** Price as a fixed-decimals string (what clients, Redis and the database see). */
  format(price = this.price): string {
    return price.toFixed(this.params.decimals);
  }
}

export interface OtcAsset {
  id: number;
  symbol: string;
  otc: OtcParams;
}

export interface OtcHistoryRow {
  assetId: number;
  price: string;
  capturedAt: Date;
}

export interface OtcFeedDeps {
  /** Newest stored price, to continue the same path after a restart. */
  lastPrice(assetId: number): Promise<number | null>;
  /** Writes generated history for a brand-new asset, so its chart is not empty. */
  writeHistory(rows: readonly OtcHistoryRow[]): Promise<void>;
  normal?: NormalSource;
  onError(err: unknown, symbol: string): void;
}

/** Seconds of history generated for a new OTC asset. */
export const OTC_HISTORY_S = 48 * 3600;
const HISTORY_CHUNK = 20_000;

/** Runs one walk per enabled OTC asset and turns each step into a Tick. */
export class OtcFeed {
  private readonly walks = new Map<string, { walk: OtcWalk; lastMs: number; asset: OtcAsset }>();
  private readonly starting = new Set<string>();
  private readonly normal: NormalSource;

  constructor(private readonly deps: OtcFeedDeps) {
    this.normal = deps.normal ?? cryptoNormal();
  }

  /** Adds new assets (async: may write history first), updates parameters, drops removed ones. */
  sync(assets: readonly OtcAsset[], now: number): Promise<void> {
    const keep = new Set(assets.map((a) => a.symbol));
    for (const s of this.walks.keys()) if (!keep.has(s)) this.walks.delete(s);
    const starts: Array<Promise<void>> = [];
    for (const a of assets) {
      const cur = this.walks.get(a.symbol);
      if (cur) {
        cur.walk.setParams(a.otc);
        cur.asset = a;
      } else if (!this.starting.has(a.symbol)) {
        starts.push(this.begin(a, now));
      }
    }
    return Promise.all(starts).then(() => undefined);
  }

  private async begin(a: OtcAsset, now: number): Promise<void> {
    this.starting.add(a.symbol);
    try {
      const last = await this.deps.lastPrice(a.id);
      let walk: OtcWalk;
      if (last !== null && last > 0) {
        // Continue where it stopped; any downtime shows as a gap, like a halted market.
        walk = new OtcWalk(a.otc, last, this.normal);
      } else {
        walk = new OtcWalk(a.otc, a.otc.startPrice, this.normal);
        await this.history(a, walk, now);
      }
      this.walks.set(a.symbol, { walk, lastMs: now, asset: a });
    } catch (err) {
      this.deps.onError(err, a.symbol);
    } finally {
      this.starting.delete(a.symbol);
    }
  }

  /** One point per second for the last OTC_HISTORY_S, ending just before `now`. */
  private async history(a: OtcAsset, walk: OtcWalk, now: number): Promise<void> {
    const startMs = Math.floor(now / 1000) * 1000 - OTC_HISTORY_S * 1000;
    let rows: OtcHistoryRow[] = [];
    for (let i = 0; i < OTC_HISTORY_S; i++) {
      rows.push({ assetId: a.id, price: walk.format(walk.step(1)), capturedAt: new Date(startMs + i * 1000) });
      if (rows.length === HISTORY_CHUNK) {
        await this.deps.writeHistory(rows);
        rows = [];
      }
    }
    if (rows.length > 0) await this.deps.writeHistory(rows);
  }

  /** Advances every walk to `now` and returns one tick per asset. */
  tick(now: number): Tick[] {
    const out: Tick[] = [];
    for (const [symbol, s] of this.walks) {
      const p = s.walk.step((now - s.lastMs) / 1000);
      s.lastMs = now;
      const price = s.walk.format(p);
      out.push({ symbol, price, value: Number(price), ts: now, recvMs: now, provider: 'otc' });
    }
    return out;
  }

  symbols(): string[] {
    return [...this.walks.keys()];
  }
}
