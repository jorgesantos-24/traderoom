import { parseOtcOverride } from '@traderoom/shared';
import { Backoff } from '../lib/backoff.js';
import type { Logger } from '../lib/log.js';
import type { Counter, Registry } from '../lib/metrics.js';
import { Conflator, SeqCounter, staleFrame, type PublishedPrice } from './conflator.js';
import { FeedConnection } from './connection.js';
import { OtcFeed } from './otc.js';
import { binanceSpec } from './providers.js';
import type { RelaySinks, SnapshotRow } from './sinks.js';
import { SourceSelector } from './source-selector.js';
import { StaleTracker, type StaleChange } from './stale-tracker.js';
import type { FeedAsset, FeedProvider, Tick } from './types.js';

export interface RelayOptions {
  binanceUrl: string;
  /** A second Binance endpoint (same market), used only while the primary is silent. */
  binanceBackupUrl: string;
  /** Symbol is stale after this long without an accepted tick. */
  staleMs: number;
  /** Switch to the fallback after this long without a primary tick. */
  failoverMs: number;
  /** Return to the primary after it is stable for this long. */
  recoverStableMs: number;
  /** Conflation window. */
  windowMs: number;
  /** How often staleness and failover are re-evaluated. */
  evaluateMs: number;
  snapshotMs: number;
  assetsReloadMs: number;
  /** Reconnect a provider socket that delivers nothing for this long. */
  idleTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  handshakeTimeoutMs: number;
  /** How often OTC prices move. */
  otcTickMs: number;
}

/** Values fixed by the spec; only tests override them. */
export const RELAY_DEFAULTS = {
  staleMs: 2000,
  failoverMs: 5000,
  recoverStableMs: 60_000,
  windowMs: 200,
  evaluateMs: 100,
  snapshotMs: 1000,
  assetsReloadMs: 30_000,
  idleTimeoutMs: 10_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  handshakeTimeoutMs: 10_000,
  otcTickMs: 500,
} satisfies Omit<RelayOptions, 'binanceUrl' | 'binanceBackupUrl'>;

export interface RelayListener {
  /** Once per window with every symbol that changed. */
  onPrices?(prices: readonly PublishedPrice[]): void;
  onStale?(change: StaleChange, frame: Buffer): void;
  /** After the enabled asset list changed (not on start). */
  onAssets?(assets: readonly FeedAsset[]): void;
}

export interface RelayDeps {
  sinks: RelaySinks;
  log: Logger;
  metrics: Registry;
  now?: () => number;
}

interface RelayCounters {
  received: Counter;
  accepted: Counter;
  frames: Counter;
  reconnects: Counter;
  switches: Counter;
  staleEvents: Counter;
  redisErrors: Counter;
  snapshotRows: Counter;
  snapshotErrors: Counter;
  snapshotSkipped: Counter;
}

/** Logs the first failure, then at most one summary per interval. */
class ThrottledError {
  private lastLogMs = -Infinity;
  private suppressed = 0;

  constructor(
    private readonly log: Logger,
    private readonly msg: string,
    private readonly intervalMs = 10_000,
  ) {}

  report(err: unknown, now: number): void {
    if (now - this.lastLogMs < this.intervalMs) {
      this.suppressed += 1;
      return;
    }
    this.log.error({ err, suppressed: this.suppressed }, this.msg);
    this.lastLogMs = now;
    this.suppressed = 0;
  }
}

/**
 * The single upstream market-data relay: one Binance socket for all enabled
 * assets plus a hot standby on a second Binance endpoint, merged per symbol, conflated every
 * window and fanned out to Redis and in-process listeners.
 */
export class Relay {
  private assetList: FeedAsset[] = [];
  /** Assets priced by Binance (the rest are OTC). */
  private marketList: FeedAsset[] = [];
  private readonly otcSymbols = new Set<string>();
  private readonly otc: OtcFeed;
  private assetsKey = '';
  private readonly assetsBySymbol = new Map<string, FeedAsset>();
  private readonly lastAccepted = new Map<string, Tick>();
  private readonly listeners = new Set<RelayListener>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly seq = new SeqCounter();
  private readonly conflator = new Conflator(this.seq);
  private readonly selector: SourceSelector;
  private readonly stale: StaleTracker;
  private readonly connections: Record<'binance' | 'binance_backup', FeedConnection>;
  private readonly now: () => number;

  private unwritten = new Map<string, Tick>();
  private priceWriteInFlight = false;
  private snapshotInFlight = false;
  private reloadInFlight = false;
  private overrideInFlight = false;
  /** Last raw `otc:override` seen; only a change is re-applied. */
  private lastOverrideRaw: string | null = null;
  private started = false;

  private readonly m: RelayCounters;
  private readonly redisErrors: ThrottledError;
  private readonly snapshotErrors: ThrottledError;

  constructor(
    private readonly opts: RelayOptions,
    private readonly deps: RelayDeps,
  ) {
    this.now = deps.now ?? Date.now;
    const now = this.now();
    this.selector = new SourceSelector(
      { failoverMs: opts.failoverMs, recoverStableMs: opts.recoverStableMs, gapMs: opts.staleMs },
      [],
      now,
    );
    this.stale = new StaleTracker(opts.staleMs, []);
    this.redisErrors = new ThrottledError(deps.log, 'failed to write prices to redis');
    this.snapshotErrors = new ThrottledError(deps.log, 'failed to insert price snapshots');

    const reg = deps.metrics;
    this.m = {
      received: reg.counter('feed_ticks_received_total', 'Trades received from providers.'),
      accepted: reg.counter('feed_ticks_accepted_total', 'Trades used as prices (from the active provider).'),
      frames: reg.counter('feed_frames_published_total', 'Conflated tick frames published.'),
      reconnects: reg.counter('feed_reconnects_total', 'Unplanned provider reconnects.'),
      switches: reg.counter('feed_source_switches_total', 'Per-symbol provider switches.'),
      staleEvents: reg.counter('feed_stale_events_total', 'Symbols that went stale.'),
      redisErrors: reg.counter('feed_redis_write_errors_total', 'Failed price writes to Redis.'),
      snapshotRows: reg.counter('feed_snapshot_rows_total', 'Rows inserted into price_snapshots.'),
      snapshotErrors: reg.counter('feed_snapshot_errors_total', 'Failed price_snapshots inserts.'),
      snapshotSkipped: reg.counter('feed_snapshot_skipped_total', 'Snapshot rounds skipped because the previous insert was still running.'),
    };

    // Gauges are computed at scrape time from relay state.
    reg.gauge('feed_provider_connected', 'Provider socket is open (1) or not (0).', () => [
      [{ provider: 'binance' }, this.connections.binance.connected ? 1 : 0],
      [{ provider: 'binance_backup' }, this.connections.binance_backup.connected ? 1 : 0],
    ]);
    reg.gauge('feed_lag_ms', 'ms since the last accepted tick, per symbol.', () => this.perSymbol((s, n) => this.stale.ageMs(s, n)));
    reg.gauge('feed_exchange_delay_ms', 'Receive time minus exchange trade time of the last accepted tick.', () =>
      this.perSymbol((s) => {
        const t = this.lastAccepted.get(s);
        return t ? t.recvMs - t.ts : null;
      }),
    );
    reg.gauge('feed_stale', 'Symbol is stale (1) or fresh (0).', () => this.perSymbol((s) => (this.stale.isStale(s) ? 1 : 0)));
    reg.gauge('feed_source', 'Provider currently used per symbol (value is always 1).', () =>
      this.assetList.map((a) => [{ symbol: a.symbol, provider: this.selector.sourceOf(a.symbol) ?? 'none' }, 1] as const),
    );

    const mkConn = (name: FeedProvider, spec: () => ReturnType<typeof binanceSpec>): FeedConnection =>
      new FeedConnection({
        name,
        spec,
        onTick: (t) => this.onTick(t),
        onReconnect: () => this.m.reconnects.inc({ provider: name }),
        backoff: new Backoff({ baseMs: opts.backoffBaseMs, maxMs: opts.backoffMaxMs }),
        log: deps.log,
        idleTimeoutMs: opts.idleTimeoutMs,
        handshakeTimeoutMs: opts.handshakeTimeoutMs,
        now: this.now,
      });
    this.connections = {
      binance: mkConn('binance', () => binanceSpec(opts.binanceUrl, this.marketList)),
      binance_backup: mkConn('binance_backup', () => binanceSpec(opts.binanceBackupUrl, this.marketList, 'binance_backup')),
    };
    const otcErrors = new ThrottledError(deps.log, 'failed to start OTC asset');
    this.otc = new OtcFeed({
      lastPrice: (id) => deps.sinks.lastPrice?.(id) ?? Promise.resolve(null),
      writeHistory: (rows) => deps.sinks.writeSnapshots(rows),
      now: () => this.now(),
      onError: (err) => otcErrors.report(err, this.now()),
    });
  }

  /** Loads assets and starts both provider sockets and all timers. Throws if assets cannot be loaded. */
  async start(): Promise<void> {
    if (this.started) return;
    this.applyAssets(await this.deps.sinks.loadAssets());
    // New OTC assets write their history before they tick, so their first chart already has candles.
    // That can take minutes on a first boot; it runs in the background so Binance and every OTC
    // asset that already has history go live right away.
    void this.syncOtc();
    await this.pollOverride();
    this.started = true;
    this.connections.binance.start();
    this.connections.binance_backup.start();
    this.every(this.opts.otcTickMs, () => this.tickOtc());
    this.every(this.opts.otcTickMs, () => void this.pollOverride());
    this.every(this.opts.windowMs, () => this.flushWindow());
    this.every(this.opts.evaluateMs, () => this.evaluate());
    this.every(this.opts.snapshotMs, () => this.snapshot());
    this.every(this.opts.assetsReloadMs, () => void this.reloadAssets());
    this.deps.log.info({ assets: this.assetList.map((a) => a.symbol) }, 'relay started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    await Promise.all([this.connections.binance.stop(), this.connections.binance_backup.stop()]);
  }

  listen(l: RelayListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  isStale(symbol: string): boolean {
    return this.stale.isStale(symbol);
  }

  /** Newest accepted tick (may be newer than the last published frame). */
  latest(symbol: string): Tick | undefined {
    return this.lastAccepted.get(symbol);
  }

  sourceOf(symbol: string): FeedProvider | undefined {
    if (this.otcSymbols.has(symbol)) return 'otc';
    return this.selector.sourceOf(symbol);
  }

  assets(): readonly FeedAsset[] {
    return this.assetList;
  }

  /** Newest accepted receive time across all symbols, or null. */
  lastTickMs(): number | null {
    let newest: number | null = null;
    for (const t of this.lastAccepted.values()) if (newest === null || t.recvMs > newest) newest = t.recvMs;
    return newest;
  }

  seqCounter(): SeqCounter {
    return this.seq;
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  private perSymbol(fn: (symbol: string, now: number) => number | null): Array<[{ symbol: string }, number]> {
    const now = this.now();
    const out: Array<[{ symbol: string }, number]> = [];
    for (const a of this.assetList) {
      const v = fn(a.symbol, now);
      if (v !== null) out.push([{ symbol: a.symbol }, v]);
    }
    return out;
  }

  private applyAssets(assets: FeedAsset[]): boolean {
    const key = assets
      .map((a) => `${a.id}:${a.symbol}:${a.binanceStream}:${a.otc ? `${a.otc.startPrice}/${a.otc.volPctHour}/${a.otc.decimals}/${a.otc.driftPctHour ?? 0}` : ''}`)
      .join(',');
    if (key === this.assetsKey) return false;
    this.assetsKey = key;
    this.assetList = assets;
    this.marketList = assets.filter((a) => !a.otc);
    this.otcSymbols.clear();
    for (const a of assets) if (a.otc) this.otcSymbols.add(a.symbol);
    this.assetsBySymbol.clear();
    for (const a of assets) this.assetsBySymbol.set(a.symbol, a);
    for (const sym of this.lastAccepted.keys()) if (!this.assetsBySymbol.has(sym)) this.lastAccepted.delete(sym);
    const now = this.now();
    this.selector.setSymbols(
      // The backup is the same Binance market, so every asset can fail over to it.
      this.marketList.map((a) => ({ symbol: a.symbol, hasFallback: true })),
      now,
    );
    this.stale.setSymbols(assets.map((a) => a.symbol));
    return true;
  }

  private async reloadAssets(): Promise<void> {
    if (this.reloadInFlight || !this.started) return;
    this.reloadInFlight = true;
    try {
      const assets = await this.deps.sinks.loadAssets();
      if (this.started && this.applyAssets(assets)) {
        this.deps.log.info({ assets: assets.map((a) => a.symbol) }, 'enabled assets changed; resubscribing');
        for (const l of this.listeners) l.onAssets?.(this.assetList);
        this.connections.binance.restart();
        this.connections.binance_backup.restart();
      }
      // Also retries OTC assets that failed to start (e.g. the database was briefly unreachable).
      if (this.started) void this.syncOtc();
    } catch (err) {
      this.deps.log.error({ err }, 'failed to reload assets; keeping current list');
    } finally {
      this.reloadInFlight = false;
    }
  }

  private syncOtc(): Promise<void> {
    const list = this.assetList.flatMap((a) => (a.otc ? [{ id: a.id, symbol: a.symbol, otc: a.otc }] : []));
    return this.otc.sync(list, this.now());
  }

  /** Reads the override from Redis and hands it to the OTC generator when it changed. */
  private async pollOverride(): Promise<void> {
    const read = this.deps.sinks.readOverride;
    if (!read || this.overrideInFlight) return;
    this.overrideInFlight = true;
    try {
      const raw = await read();
      if (raw === this.lastOverrideRaw) return;
      this.lastOverrideRaw = raw;
      const wire = parseOtcOverride(raw);
      this.otc.setOverride(wire, this.now());
      if (wire) this.deps.log.info({ symbol: wire.symbol, targetPrice: wire.targetPrice, closeMs: wire.closeMs }, 'otc override applied');
      else this.deps.log.info({ invalid: raw !== null }, 'otc override cleared');
    } catch (err) {
      this.deps.log.error({ err }, 'failed to read otc override');
    } finally {
      this.overrideInFlight = false;
    }
  }

  /** OTC ticks skip the source selector: the generator is their only source. */
  private tickOtc(): void {
    for (const t of this.otc.tick(this.now())) {
      if (!this.otcSymbols.has(t.symbol)) continue;
      this.m.received.inc({ provider: t.provider });
      this.m.accepted.inc({ provider: t.provider });
      this.lastAccepted.set(t.symbol, t);
      this.conflator.push(t);
      const change = this.stale.seen(t.symbol, t.recvMs);
      if (change) this.emitStale(change);
    }
  }

  private onTick(t: Tick): void {
    this.m.received.inc({ provider: t.provider });
    if (!this.selector.accept(t)) return;
    const prev = this.lastAccepted.get(t.symbol);
    // Never move backwards in time within one provider (late/duplicate trades).
    if (prev && prev.provider === t.provider && t.ts < prev.ts) return;
    this.m.accepted.inc({ provider: t.provider });
    this.lastAccepted.set(t.symbol, t);
    this.conflator.push(t);
    const change = this.stale.seen(t.symbol, t.recvMs);
    if (change) this.emitStale(change);
  }

  private flushWindow(): void {
    const published = this.conflator.flush();
    if (published.length === 0) return;
    this.m.frames.inc({}, published.length);
    for (const l of this.listeners) l.onPrices?.(published);
    for (const p of published) this.unwritten.set(p.tick.symbol, p.tick);
    this.writePrices();
  }

  /** Latest-wins: while a write is in flight, newer ticks accumulate and go in the next write. */
  private writePrices(): void {
    if (this.priceWriteInFlight || this.unwritten.size === 0) return;
    const batch = [...this.unwritten.values()];
    this.unwritten = new Map();
    this.priceWriteInFlight = true;
    this.deps.sinks
      .writePrices(batch)
      .catch((err: unknown) => {
        this.m.redisErrors.inc();
        this.redisErrors.report(err, this.now());
      })
      .finally(() => {
        this.priceWriteInFlight = false;
      });
  }

  private evaluate(): void {
    const now = this.now();
    for (const sw of this.selector.evaluate(now)) {
      this.m.switches.inc({ symbol: sw.symbol, to: sw.to });
      this.deps.log.warn(sw, 'feed source switched');
    }
    for (const change of this.stale.evaluate(now)) {
      this.m.staleEvents.inc({ symbol: change.symbol });
      this.deps.log.warn({ symbol: change.symbol, staleMs: this.opts.staleMs }, 'symbol is stale');
      this.emitStale(change);
    }
  }

  private emitStale(change: StaleChange): void {
    if (!change.on) this.deps.log.info({ symbol: change.symbol }, 'symbol is fresh again');
    const frame = staleFrame(change.symbol, change.on);
    for (const l of this.listeners) l.onStale?.(change, frame);
  }

  private snapshot(): void {
    if (this.snapshotInFlight) {
      this.m.snapshotSkipped.inc();
      return;
    }
    const capturedAt = new Date(this.now());
    const rows: SnapshotRow[] = [];
    for (const a of this.assetList) {
      if (this.stale.isStale(a.symbol)) continue;
      const t = this.lastAccepted.get(a.symbol);
      if (t) rows.push({ assetId: a.id, price: t.price, capturedAt });
    }
    if (rows.length === 0) return;
    this.snapshotInFlight = true;
    this.deps.sinks
      .writeSnapshots(rows)
      .then(() => this.m.snapshotRows.inc({}, rows.length))
      .catch((err: unknown) => {
        this.m.snapshotErrors.inc();
        this.snapshotErrors.report(err, this.now());
      })
      .finally(() => {
        this.snapshotInFlight = false;
      });
  }
}
