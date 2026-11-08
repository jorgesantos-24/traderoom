import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from '../src/lib/metrics.js';
import type { PublishedPrice } from '../src/feed/conflator.js';
import { RELAY_DEFAULTS, Relay, type RelayOptions } from '../src/feed/relay.js';
import type { RelaySinks, SnapshotRow } from '../src/feed/sinks.js';
import type { FeedAsset, Tick } from '../src/feed/types.js';
import { binanceQuote, binanceTrade, FakeUpstream, pump, silentLog } from './fake-upstream.js';

const ASSETS: FeedAsset[] = [
  { id: 1, symbol: 'BTCUSDT', binanceStream: 'btcusdt@bookTicker' },
  { id: 4, symbol: 'BNBUSDT', binanceStream: 'bnbusdt@bookTicker' },
];

// Spec timings scaled down ~20x so the suite runs in seconds.
const FAST: Omit<RelayOptions, 'binanceUrl' | 'binanceBackupUrl'> = {
  ...RELAY_DEFAULTS,
  staleMs: 200,
  failoverMs: 400,
  recoverStableMs: 600,
  windowMs: 50,
  evaluateMs: 20,
  snapshotMs: 100,
  assetsReloadMs: 100,
  idleTimeoutMs: 5000,
  backoffBaseMs: 20,
  backoffMaxMs: 100,
};

class FakeSinks implements RelaySinks {
  readonly priceWrites: Tick[][] = [];
  readonly snapshots: SnapshotRow[][] = [];
  assets: FeedAsset[] = ASSETS;
  failPrices = false;

  async writePrices(ticks: readonly Tick[]): Promise<void> {
    if (this.failPrices) throw new Error('redis down');
    this.priceWrites.push([...ticks]);
  }

  async writeSnapshots(rows: readonly SnapshotRow[]): Promise<void> {
    this.snapshots.push([...rows]);
  }

  async loadAssets(): Promise<FeedAsset[]> {
    return this.assets;
  }
}

let binance: FakeUpstream;
let backup: FakeUpstream;
let relay: Relay | undefined;
const stops: Array<() => void> = [];

beforeEach(async () => {
  [binance, backup] = await Promise.all([FakeUpstream.start(), FakeUpstream.start()]);
});

afterEach(async () => {
  for (const s of stops.splice(0)) s();
  await relay?.stop();
  relay = undefined;
  await Promise.all([binance.stop(), backup.stop()]);
});

async function startRelay(sinks: RelaySinks, metrics = new Registry()): Promise<Relay> {
  relay = new Relay({ ...FAST, binanceUrl: binance.url, binanceBackupUrl: backup.url }, { sinks, log: silentLog, metrics });
  await relay.start();
  await vi.waitFor(() => {
    expect(binance.open).toBe(1);
    expect(backup.open).toBe(1);
  });
  return relay;
}

describe('Relay', () => {
  it('subscribes once to both Binance endpoints with every stream', async () => {
    await startRelay(new FakeSinks());
    expect(binance.paths).toEqual(['/stream?streams=btcusdt@bookTicker/bnbusdt@bookTicker']);
    expect(backup.paths).toEqual(['/stream?streams=btcusdt@bookTicker/bnbusdt@bookTicker']);
    expect(backup.received).toEqual([]);
  });

  it('conflates a burst into one frame per symbol per window and writes the newest price', async () => {
    const sinks = new FakeSinks();
    const r = await startRelay(sinks);
    const frames: PublishedPrice[][] = [];
    r.listen({ onPrices: (p) => frames.push([...p]) });
    for (let i = 1; i <= 50; i++) binance.send(binanceQuote('BTCUSDT', `100.${String(i).padStart(2, '0')}`));
    binance.send(binanceQuote('BNBUSDT', '600.00'));
    await vi.waitFor(() => expect(frames.flat().map((p) => p.tick.symbol).sort()).toEqual(['BNBUSDT', 'BTCUSDT']));
    const btcFrames = frames.flat().filter((p) => p.tick.symbol === 'BTCUSDT');
    // 51 quotes arrive within a 50 ms window or two, never one frame each.
    expect(btcFrames.length).toBeLessThanOrEqual(2);
    expect(btcFrames.at(-1)?.tick.price).toBe('100.50000000');
    await vi.waitFor(() => expect(sinks.priceWrites.flat().some((t) => t.price === '100.50000000')).toBe(true));
  });

  it('marks a symbol stale after the threshold and fresh again on the next tick', async () => {
    const r = await startRelay(new FakeSinks());
    const events: string[] = [];
    r.listen({ onStale: (c, frame) => events.push(`${c.symbol}:${String(c.on)}:${frame.toString()}`) });
    expect(r.isStale('BTCUSDT')).toBe(true);
    // Measured from the send: the tick is received after this, so staleness can never fire earlier.
    const sentAt = Date.now();
    binance.send(binanceQuote('BTCUSDT', '100'));
    await vi.waitFor(() => expect(r.isStale('BTCUSDT')).toBe(false));
    await vi.waitFor(() => expect(r.isStale('BTCUSDT')).toBe(true));
    const detectedAfter = Date.now() - sentAt;
    expect(detectedAfter).toBeGreaterThanOrEqual(FAST.staleMs);
    expect(detectedAfter).toBeLessThan(FAST.staleMs + 150);
    binance.send(binanceQuote('BTCUSDT', '101'));
    await vi.waitFor(() => expect(r.isStale('BTCUSDT')).toBe(false));
    expect(events.filter((e) => e.startsWith('BTCUSDT'))).toEqual([
      'BTCUSDT:false:{"t":"stale","s":"BTCUSDT","on":false}',
      'BTCUSDT:true:{"t":"stale","s":"BTCUSDT","on":true}',
      'BTCUSDT:false:{"t":"stale","s":"BTCUSDT","on":false}',
    ]);
  });

  it('fails over to the backup endpoint when the primary goes quiet and returns after it is stable', async () => {
    const metrics = new Registry();
    const sinks = new FakeSinks();
    const r = await startRelay(sinks, metrics);
    stops.push(pump(backup, 20, () => binanceQuote('BTCUSDT', '99.00')));
    stops.push(pump(backup, 20, () => binanceQuote('BNBUSDT', '600.00')));
    let stopBinance = pump(binance, 20, () => binanceQuote('BTCUSDT', '100.00'));

    await vi.waitFor(() => expect(r.latest('BTCUSDT')?.provider).toBe('binance'));
    expect(r.sourceOf('BTCUSDT')).toBe('binance');

    // Primary cut: the backup takes over after failoverMs; no symbol stays stale.
    stopBinance();
    binance.dropAll();
    binance.accepting = false;
    await vi.waitFor(() => expect(r.sourceOf('BTCUSDT')).toBe('binance_backup'), { timeout: 2000 });
    await vi.waitFor(() => expect(r.latest('BTCUSDT')?.provider).toBe('binance_backup'));
    await vi.waitFor(() => expect(r.isStale('BTCUSDT')).toBe(false));
    // Every asset is covered by the backup, not just a few.
    await vi.waitFor(() => expect(r.sourceOf('BNBUSDT')).toBe('binance_backup'));
    await vi.waitFor(() => expect(r.isStale('BNBUSDT')).toBe(false));

    // Primary back: switch only after recoverStableMs of steady ticks.
    binance.accepting = true;
    await vi.waitFor(() => expect(binance.open).toBe(1), { timeout: 2000 });
    const backAt = Date.now();
    stopBinance = pump(binance, 20, () => binanceQuote('BTCUSDT', '100.00'));
    stops.push(stopBinance);
    await vi.waitFor(() => expect(r.sourceOf('BTCUSDT')).toBe('binance'), { timeout: 3000 });
    expect(Date.now() - backAt).toBeGreaterThanOrEqual(FAST.recoverStableMs - 50);
    await vi.waitFor(() => expect(r.latest('BTCUSDT')?.provider).toBe('binance'));

    const text = metrics.render();
    expect(text).toContain('feed_source_switches_total{symbol="BTCUSDT",to="binance_backup"} 1');
    expect(text).toContain('feed_source_switches_total{symbol="BTCUSDT",to="binance"} 1');
    expect(text).toMatch(/feed_reconnects_total\{provider="binance"\} [1-9]/);
  });

  it('exposes feed_realized_vol per market symbol once it has enough history', async () => {
    const metrics = new Registry();
    await startRelay(new FakeSinks(), metrics);
    const vol = () => metrics.render().match(/feed_realized_vol\{symbol="BTCUSDT"\} (\S+)/)?.[1];
    // Exchange times 1.5 s apart: 40 trades cover 60 s. Too few at first: no value (no cap) yet.
    const t0 = Date.now() - 60_000;
    const price = (i: number) => (76_000 + (i % 2 ? 3 : -3)).toFixed(2);
    for (let i = 0; i < 10; i++) binance.send(binanceTrade('BTCUSDT', price(i), t0 + i * 1500));
    await vi.waitFor(() => expect(relay?.latest('BTCUSDT')).toBeDefined());
    expect(vol()).toBeUndefined();
    for (let i = 10; i < 40; i++) binance.send(binanceTrade('BTCUSDT', price(i), t0 + i * 1500));
    await vi.waitFor(() => expect(vol()).toBeDefined());
    // ±3 on 76 000 every 1.5 s: |r| ≈ 7.9e-5, σ ≈ 7.9e-5 / √1.5 ≈ 6.4e-5 per √s, reported ×1.3 ≈ 8.3e-5.
    expect(Number(vol())).toBeGreaterThan(7e-5);
    expect(Number(vol())).toBeLessThan(9.5e-5);
  });

  it('snapshots only fresh symbols, with the exact price string', async () => {
    const sinks = new FakeSinks();
    await startRelay(sinks);
    stops.push(pump(binance, 20, () => binanceQuote('BTCUSDT', '75552.62', '75552.64')));
    await vi.waitFor(() => expect(sinks.snapshots.length).toBeGreaterThanOrEqual(2));
    for (const batch of sinks.snapshots) {
      expect(batch.map((r) => [r.assetId, r.price])).toEqual([[1, '75552.63000000']]);
    }
  });

  it('keeps publishing frames when Redis writes fail, and catches up after', async () => {
    const metrics = new Registry();
    const sinks = new FakeSinks();
    sinks.failPrices = true;
    const r = await startRelay(sinks, metrics);
    let frames = 0;
    r.listen({ onPrices: (p) => (frames += p.length) });
    stops.push(pump(binance, 20, () => binanceQuote('BTCUSDT', '1.5')));
    await vi.waitFor(() => expect(frames).toBeGreaterThanOrEqual(3));
    expect(metrics.render()).toMatch(/feed_redis_write_errors_total [1-9]/);
    sinks.failPrices = false;
    await vi.waitFor(() => expect(sinks.priceWrites.length).toBeGreaterThan(0));
  });

  it('resubscribes when the enabled asset list changes', async () => {
    const sinks = new FakeSinks();
    const r = await startRelay(sinks);
    sinks.assets = [...ASSETS, { id: 2, symbol: 'ETHUSDT', binanceStream: 'ethusdt@bookTicker' }];
    await vi.waitFor(() => expect(binance.paths.at(-1)).toBe('/stream?streams=btcusdt@bookTicker/bnbusdt@bookTicker/ethusdt@bookTicker'));
    await vi.waitFor(() => expect(r.assets().map((a) => a.symbol)).toContain('ETHUSDT'));
    await vi.waitFor(() => expect(backup.paths.at(-1)).toBe('/stream?streams=btcusdt@bookTicker/bnbusdt@bookTicker/ethusdt@bookTicker'));
  });

  it('prices Binance quotes at the exact bid/ask mid', async () => {
    const r = await startRelay(new FakeSinks());
    binance.send(binanceQuote('BTCUSDT', '100.00000001', '100.00000002'));
    await vi.waitFor(() => expect(r.latest('BTCUSDT')?.price).toBe('100.00000002'));
    expect(r.latest('BTCUSDT')?.value).toBe(100.00000002);
  });

  it('ignores ticks for symbols that are not enabled', async () => {
    const sinks = new FakeSinks();
    const r = await startRelay(sinks);
    binance.send(binanceQuote('XRPUSDT', '0.5'));
    binance.send(binanceQuote('BTCUSDT', '100'));
    await vi.waitFor(() => expect(r.latest('BTCUSDT')).toBeDefined());
    expect(r.latest('XRPUSDT')).toBeUndefined();
  });
});
