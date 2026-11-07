import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backoff } from '../src/lib/backoff.js';
import { FeedConnection, type FeedConnectionOptions } from '../src/feed/connection.js';
import { parseBinanceMessage } from '../src/feed/parsers.js';
import type { ProviderSpec, Tick } from '../src/feed/types.js';
import { binanceTrade, FakeUpstream, silentLog } from './fake-upstream.js';

let up: FakeUpstream;
let conn: FeedConnection | undefined;

beforeEach(async () => {
  up = await FakeUpstream.start();
});

afterEach(async () => {
  await conn?.stop();
  conn = undefined;
  await up.stop();
});

function make(overrides: Partial<FeedConnectionOptions> = {}): { conn: FeedConnection; ticks: Tick[]; reconnects: number[] } {
  const ticks: Tick[] = [];
  const reconnects: number[] = [];
  const spec: ProviderSpec = { name: 'binance', url: up.url, onOpenMessages: ['{"hello":1}'], parse: parseBinanceMessage };
  conn = new FeedConnection({
    name: 'binance',
    spec: () => spec,
    onTick: (t) => ticks.push(t),
    onReconnect: (i) => reconnects.push(i.delayMs),
    backoff: new Backoff({ baseMs: 20, maxMs: 200 }),
    log: silentLog,
    idleTimeoutMs: 5000,
    ...overrides,
  });
  return { conn, ticks, reconnects };
}

describe('FeedConnection', () => {
  it('connects, sends the open messages and delivers ticks', async () => {
    const { conn, ticks } = make();
    conn.start();
    await vi.waitFor(() => expect(up.open).toBe(1));
    await vi.waitFor(() => expect(up.received).toEqual(['{"hello":1}']));
    expect(conn.connected).toBe(true);
    up.send(binanceTrade('BTCUSDT', '100.5'));
    await vi.waitFor(() => expect(ticks.map((t) => t.price)).toEqual(['100.5']));
  });

  it('reconnects with backoff after the upstream drops the socket', async () => {
    const { conn, ticks, reconnects } = make();
    conn.start();
    await vi.waitFor(() => expect(up.open).toBe(1));
    up.dropAll();
    await vi.waitFor(() => expect(up.connections).toBe(2));
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]).toBeGreaterThanOrEqual(20);
    await vi.waitFor(() => expect(up.open).toBe(1));
    up.send(binanceTrade('BTCUSDT', '101'));
    await vi.waitFor(() => expect(ticks).toHaveLength(1));
  });

  it('keeps retrying while the upstream refuses connections, then recovers', async () => {
    const { conn, reconnects } = make();
    up.accepting = false;
    conn.start();
    await vi.waitFor(() => expect(reconnects.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    // Delays grow: base 20 → up to 200.
    expect(Math.max(...reconnects)).toBeGreaterThan(reconnects[0] ?? 0);
    up.accepting = true;
    await vi.waitFor(() => expect(conn.connected).toBe(true), { timeout: 3000 });
  });

  it('terminates a silent socket after the idle timeout and reconnects', async () => {
    const { conn, reconnects } = make({ idleTimeoutMs: 150 });
    conn.start();
    await vi.waitFor(() => expect(up.connections).toBe(1));
    await vi.waitFor(() => expect(up.connections).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    expect(conn).toBeDefined();
  });

  it('resets the backoff once a socket delivers a tick', async () => {
    const backoff = new Backoff({ baseMs: 20, maxMs: 200 });
    const { conn } = make({ backoff });
    up.accepting = false;
    conn.start();
    await vi.waitFor(() => expect(backoff.attempts).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    up.accepting = true;
    await vi.waitFor(() => expect(up.open).toBe(1), { timeout: 3000 });
    up.send(binanceTrade('BTCUSDT', '1'));
    await vi.waitFor(() => expect(backoff.attempts).toBe(0));
  });

  it('restart() reconnects immediately without counting a reconnect', async () => {
    const { conn, reconnects } = make();
    conn.start();
    await vi.waitFor(() => expect(up.open).toBe(1));
    conn.restart();
    await vi.waitFor(() => expect(up.connections).toBe(2));
    expect(reconnects).toEqual([]);
  });

  it('stop() closes the socket and stops reconnecting', async () => {
    const { conn } = make();
    conn.start();
    await vi.waitFor(() => expect(up.open).toBe(1));
    await conn.stop();
    await vi.waitFor(() => expect(up.open).toBe(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(up.connections).toBe(1);
    expect(conn.connected).toBe(false);
  });

  it('stays idle when there is nothing to subscribe', async () => {
    const { conn } = make({ spec: () => null });
    conn.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(up.connections).toBe(0);
  });
});
