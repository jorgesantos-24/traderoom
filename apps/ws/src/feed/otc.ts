import { randomFillSync } from 'node:crypto';
import { OTC_OVERRIDE_LANDING_MS, OTC_OVERRIDE_RELEASE_MS, type OtcOverrideWire } from '@traderoom/shared';
import type { Tick } from './types.js';

/**
 * OTC prices: a random walk we generate ourselves, for assets with no exchange behind them.
 *
 * Fairness rules (keep them):
 * - The generator only sees its own parameters and a random source. It never sees orders,
 *   positions or users, so it cannot move against anyone's trade.
 * - The random source is the OS CSPRNG, so the next move cannot be predicted from past ones.
 * - Admins set parameters (start price, volatility); they cannot set or nudge the price itself.
 *   Exception: an override (below) forces one candle's close, and only that candle.
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

/** One intervention, bound to a single candle: force its close, then hand the price back. */
interface ActiveOverride {
  /** Target in log-price; the exact close. */
  targetX: number;
  /** Where the price was when the admin took over (informational: the release follows the shadow). */
  basePrice: number;
  /** Ramp starts here (already clamped by the API so it ends at holdStart). */
  rampStartMs: number;
  /** From here the target is held flat, so snapshots land on it before expiry. */
  holdStartMs: number;
  closeMs: number;
  /** Override is dropped here, after the candle is closed and the price is back. */
  releaseEndMs: number;
  /** Log-price where the ramp starts. Set when the ramp begins, never at capture. */
  x0: number | null;
  /**
   * The path the price would have taken. Born at the ramp start, from the visible price, and only
   * then allowed to diverge: the gap the release must cover is the noise of hold+release, not of
   * the whole candle.
   */
  shadow: OtcWalk | null;
}

/**
 * One asset's path in log-price: mean-reverting walk with a slowly changing drift.
 * dx = (μ − θ·(x − a))·dt + σ·√dt·Z
 */
export class OtcWalk {
  private x: number;
  private drift = 0;
  private trendLeftS = 0;
  private params: OtcParams;
  private ov: ActiveOverride | null = null;

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
    // The counterfactual path follows the same parameters, otherwise the return price is off.
    this.ov?.shadow?.setParams(p);
  }

  get price(): number {
    return Math.exp(this.x);
  }

  get overrideActive(): boolean {
    return this.ov !== null;
  }

  /**
   * Installs (or replaces) the intervention. Called on every tick with the same payload from Redis,
   * so it must be idempotent: same candle and same target must not restart the ramp or reset `x0`.
   */
  setOverride(o: OtcOverrideWire | null, nowMs: number): void {
    if (!o) {
      this.ov = null;
      return;
    }
    const target = Number(o.targetPrice);
    const base = Number(o.basePrice);
    if (!(target > 0)) {
      this.ov = null;
      return;
    }
    const targetX = Math.log(target);
    if (this.ov && this.ov.closeMs === o.closeMs && this.ov.targetX === targetX) {
      // Same intervention: only pull the ramp earlier if the API decided so.
      this.ov.rampStartMs = Math.min(this.ov.rampStartMs, o.rampStartMs);
      return;
    }
    // A finished one arriving again (the key outlives the release by its TTL margin, or the ws
    // restarted): installing it would only cost the walk a natural step.
    if (nowMs >= o.closeMs + o.releaseMs) {
      this.ov = null;
      return;
    }
    // A new intervention (first one, new target or another candle): nothing is captured yet, the
    // ramp start does that, so a target set long before the ramp does not drag an old price in.
    this.ov = {
      targetX,
      basePrice: base > 0 ? base : this.price,
      // Never in the past: read late (poll lag, restart, re-target) the ramp would start half done and jump.
      rampStartMs: Math.min(Math.max(o.rampStartMs, nowMs), o.closeMs - o.holdMs),
      holdStartMs: o.closeMs - o.holdMs,
      closeMs: o.closeMs,
      releaseEndMs: o.closeMs + o.releaseMs,
      x0: null,
      shadow: null,
    };
    // Re-targeting mid-ramp: the new ramp starts where the price is now, not from the old anchor.
    if (nowMs >= this.ov.rampStartMs) this.ov.x0 = this.x;
  }

  /** Volatility per √second, from the hourly figure. */
  private sigma(): number {
    return this.params.volPctHour / 100 / Math.sqrt(3600);
  }

  /** One step of the untouched path. */
  private naturalStep(dtS: number): number {
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

  /**
   * Advances `dtS` seconds and returns the new (unrounded) price.
   * `atMs` is wall clock: the intervention is driven by it, not by how often this is called.
   */
  step(dtS: number, atMs: number): number {
    if (dtS <= 0) return this.price;
    const ov = this.ov;
    if (!ov) return this.naturalStep(dtS);

    if (atMs >= ov.releaseEndMs) {
      this.ov = null;
      // Never ramped (installed after the fact): nothing to hand back, just keep walking.
      if (!ov.shadow) return this.naturalStep(dtS);
      // Back on the natural path: hand over to it from here, no jump.
      ov.shadow.step(dtS, atMs);
      this.x = Math.log(ov.shadow.price);
      return this.price;
    }

    // closeMs itself still belongs to the hold: a snapshot stamped exactly at expiry must see the target.
    if (atMs > ov.closeMs) {
      // Candle closed on the target. Ease back to the live counterfactual price (τ ≈ release/3).
      ov.shadow?.step(dtS, atMs);
      const to = ov.shadow ? Math.log(ov.shadow.price) : this.x;
      const k = 1 - Math.exp(-dtS / (OTC_OVERRIDE_RELEASE_MS / 1000 / 3));
      this.x += (to - this.x) * k;
      return this.price;
    }

    if (atMs >= ov.rampStartMs) {
      // Seeded here, from the visible price, so the counterfactual starts where the ramp does.
      if (!ov.shadow) {
        ov.shadow = new OtcWalk(this.params, this.price, this.normal);
        ov.x0 = this.x;
      }
      ov.shadow.step(dtS, atMs);

      // Hold: exact target. This is the price the expiry snapshots pick up. It lands a little before
      // holdStart, so a snapshot early in the hold never reads the last ramp tick.
      const landMs = Math.max(ov.rampStartMs, ov.holdStartMs - OTC_OVERRIDE_LANDING_MS);
      if (atMs >= landMs) {
        this.x = ov.targetX;
        return this.price;
      }
      // Ramp: deterministic easeOutCubic, no noise, so arrival is guaranteed.
      const span = Math.max(1, landMs - ov.rampStartMs);
      const p = Math.min(1, Math.max(0, (atMs - ov.rampStartMs) / span));
      const eased = 1 - (1 - p) ** 3;
      const from = ov.x0 ?? this.x;
      this.x = from + (ov.targetX - from) * eased;
      return this.price;
    }

    return this.naturalStep(dtS);
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
  /** Clock for assets started after others finished their history. Default: the `now` given to sync. */
  now?: () => number;
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

  /**
   * Adds new assets (async: may write history first), updates parameters, drops removed ones.
   * New assets start one at a time: a first boot writes 48 h of history per asset, and doing them
   * all at once starves a small database's connection pool. An asset that fails to start is retried
   * on the next sync.
   */
  async sync(assets: readonly OtcAsset[], now: number): Promise<void> {
    const keep = new Set(assets.map((a) => a.symbol));
    for (const s of this.walks.keys()) if (!keep.has(s)) this.walks.delete(s);
    const pending: OtcAsset[] = [];
    for (const a of assets) {
      const cur = this.walks.get(a.symbol);
      if (cur) {
        cur.walk.setParams(a.otc);
        cur.asset = a;
      } else if (!this.starting.has(a.symbol)) {
        this.starting.add(a.symbol);
        pending.push(a);
      }
    }
    for (const [i, a] of pending.entries()) await this.begin(a, i === 0 || !this.deps.now ? now : this.deps.now());
  }

  /** Applies the active override to its asset only; every other walk is released. */
  setOverride(o: OtcOverrideWire | null, nowMs: number): void {
    for (const [symbol, s] of this.walks) {
      s.walk.setOverride(o && o.symbol === symbol ? o : null, nowMs);
    }
  }

  private async begin(a: OtcAsset, now: number): Promise<void> {
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
      rows.push({ assetId: a.id, price: walk.format(walk.step(1, startMs + i * 1000)), capturedAt: new Date(startMs + i * 1000) });
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
      const p = s.walk.step((now - s.lastMs) / 1000, now);
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