import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WS_MAX_ASSETS_PER_CONNECTION, type ServerFrame } from '@traderoom/shared';
import { Conflator, SeqCounter, staleFrame } from '../src/feed/conflator.js';
import type { RelayListener } from '../src/feed/relay.js';
import type { FeedAsset, Tick } from '../src/feed/types.js';
import { GATEWAY_DEFAULTS, Gateway, type GatewayOptions, type PriceSource } from '../src/gateway/gateway.js';
import type { SessionStore, WsSession } from '../src/gateway/session.js';
import { Registry } from '../src/lib/metrics.js';
import { silentLog } from './fake-upstream.js';

const ORIGIN = 'https://app.test';

class FakeSource implements PriceSource {
  readonly listeners = new Set<RelayListener>();
  readonly seq = new SeqCounter();
  readonly conflator = new Conflator(this.seq);
  readonly prices = new Map<string, Tick>();
  readonly stale = new Set<string>();
  list: FeedAsset[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'].map((symbol, i) => ({
    id: i + 1,
    symbol,
    binanceStream: `${symbol.toLowerCase()}@bookTicker`,
  }));

  listen(l: RelayListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  latest(symbol: string): Tick | undefined {
    return this.prices.get(symbol);
  }
  isStale(symbol: string): boolean {
    return this.stale.has(symbol);
  }
  assets(): readonly FeedAsset[] {
    return this.list;
  }
  seqCounter(): SeqCounter {
    return this.seq;
  }

  /** Publishes one conflated window, like the relay does every 200 ms. */
  publish(...ticks: Array<[string, number]>): void {
    for (const [symbol, value] of ticks) {
      const t: Tick = { symbol, price: String(value), value, ts: Date.now(), recvMs: Date.now(), provider: 'binance' };
      this.prices.set(symbol, t);
      this.conflator.push(t);
    }
    const out = this.conflator.flush();
    for (const l of this.listeners) l.onPrices?.(out);
  }

  setStale(symbol: string, on: boolean): void {
    if (on) this.stale.add(symbol);
    else this.stale.delete(symbol);
    for (const l of this.listeners) l.onStale?.({ symbol, on }, staleFrame(symbol, on));
  }

  changeAssets(symbols: string[]): void {
    this.list = this.list.filter((a) => symbols.includes(a.symbol));
    for (const l of this.listeners) l.onAssets?.(this.list);
  }
}

/** Cookie `sid=<user>:<session>` → valid; `revoked` set simulates logout/block. */
class FakeSessions implements SessionStore {
  readonly revoked = new Set<string>();
  async resolve(cookie: string | undefined): Promise<WsSession | null> {
    const m = /sid=([a-z0-9]+):([a-z0-9]+)/.exec(cookie ?? '');
    if (!m?.[1] || !m[2] || this.revoked.has(m[2])) return null;
    return { userId: m[1], sessionId: m[2] };
  }
  async stillValid(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => !this.revoked.has(id)));
  }
}

let server: Server;
let source: FakeSource;
let sessions: FakeSessions;
let gateway: Gateway;
let metrics: Registry;
const sockets: WebSocket[] = [];

async function start(overrides: Partial<GatewayOptions> = {}): Promise<void> {
  server = createServer((_req, res) => res.writeHead(404).end());
  source = new FakeSource();
  sessions = new FakeSessions();
  metrics = new Registry();
  gateway = new Gateway(server, source, sessions, { ...GATEWAY_DEFAULTS, allowedOrigin: ORIGIN, ...overrides }, { log: silentLog, metrics });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

interface Conn {
  ws: WebSocket;
  frames: ServerFrame[];
  binary: boolean[];
  closed: Promise<{ code: number; reason: string }>;
  send(msg: unknown): void;
}

function connect(opts: { cookie?: string | null; origin?: string; path?: string; autoPong?: boolean } = {}): Conn {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? 'sid=u1:s1' : opts.cookie;
  if (cookie !== null) headers['cookie'] = cookie;
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/ws'}`, { headers, autoPong: opts.autoPong ?? true });
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  const binary: boolean[] = [];
  ws.on('message', (d, isBinary) => {
    binary.push(isBinary);
    frames.push(JSON.parse(d.toString()) as ServerFrame);
  });
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  return {
    ws,
    frames,
    binary,
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  };
}

async function opened(c: Conn): Promise<Conn> {
  if (c.ws.readyState !== WebSocket.OPEN) await new Promise((r) => c.ws.once('open', r));
  return c;
}

function upgradeStatus(opts: Parameters<typeof connect>[0]): Promise<number> {
  const c = connect(opts);
  return new Promise((resolve) => c.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
}

const of = <T extends ServerFrame['t']>(c: Conn, t: T) => c.frames.filter((f): f is Extract<ServerFrame, { t: T }> => f.t === t);

describe('handshake', () => {
  it('closes with 4401 without a session cookie', async () => {
    expect(await connect({ cookie: null }).closed).toMatchObject({ code: 4401 });
  });

  it('closes with 4401 for an invalid session', async () => {
    sessions.revoked.add('s1');
    expect(await connect().closed).toMatchObject({ code: 4401 });
  });

  it('accepts a valid session from the app origin or without Origin', async () => {
    await opened(connect({ origin: ORIGIN }));
    await opened(connect({ cookie: 'sid=u2:s2' }));
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(2));
  });

  it('rejects a foreign Origin with HTTP 403 (cross-site hijacking)', async () => {
    expect(await upgradeStatus({ origin: 'https://evil.test' })).toBe(403);
  });

  it('only upgrades on /ws', async () => {
    expect(await upgradeStatus({ path: '/other' })).toBe(404);
  });

  it('allows 3 connections per user and closes the 4th with 4409', async () => {
    for (let i = 0; i < 3; i++) await opened(connect({ cookie: `sid=u1:s${i}` }));
    expect(await connect({ cookie: 'sid=u1:s9' }).closed).toMatchObject({ code: 4409 });
    // Another user is unaffected.
    await opened(connect({ cookie: 'sid=u2:s2' }));
  });

  it('frees the slot when a connection closes', async () => {
    const conns = await Promise.all([0, 1, 2].map((i) => opened(connect({ cookie: `sid=u1:s${i}` }))));
    conns[0]?.ws.close();
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(2));
    await opened(connect({ cookie: 'sid=u1:s5' }));
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(3));
  });
});

describe('protocol', () => {
  it('sends a snapshot on sub and ticks only for subscribed assets, as text frames', async () => {
    source.prices.set('BTCUSDT', { symbol: 'BTCUSDT', price: '75552.63', value: 75552.63, ts: 1, recvMs: 1, provider: 'binance' });
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['btcusdt', 'ETHUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    expect(of(c, 'snapshot')[0]?.data).toEqual([{ s: 'BTCUSDT', p: 75552.63, ts: 1 }]);

    source.publish(['BTCUSDT', 100], ['SOLUSDT', 50], ['ETHUSDT', 3000]);
    await vi.waitFor(() => expect(of(c, 'tick')).toHaveLength(2));
    expect(of(c, 'tick').map((f) => f.data[0]?.s).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(c.binary.every((b) => !b)).toBe(true);
  });

  it('keeps seq strictly increasing on each connection across snapshots and ticks', async () => {
    const a = await opened(connect({ cookie: 'sid=u1:s1' }));
    const b = await opened(connect({ cookie: 'sid=u2:s2' }));
    a.send({ t: 'sub', assets: ['BTCUSDT'] });
    await vi.waitFor(() => expect(of(a, 'snapshot')).toHaveLength(1));
    for (let i = 0; i < 5; i++) source.publish(['BTCUSDT', 100 + i], ['ETHUSDT', 10 + i]);
    b.send({ t: 'sub', assets: ['ETHUSDT', 'BTCUSDT'] });
    await vi.waitFor(() => expect(of(b, 'snapshot')).toHaveLength(1));
    a.send({ t: 'sub', assets: ['ETHUSDT'] });
    await vi.waitFor(() => expect(of(a, 'snapshot')).toHaveLength(2));
    for (let i = 0; i < 5; i++) source.publish(['BTCUSDT', 200 + i], ['ETHUSDT', 20 + i]);
    await vi.waitFor(() => expect(of(b, 'tick')).toHaveLength(10));
    await vi.waitFor(() => expect(of(a, 'tick')).toHaveLength(15));
    for (const c of [a, b]) {
      const seqs = c.frames.flatMap((f) => ('seq' in f ? [f.seq] : []));
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });

  it('stops ticks after unsub', async () => {
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['BTCUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    c.send({ t: 'unsub', assets: ['BTCUSDT'] });
    c.send({ t: 'ping' });
    await vi.waitFor(() => expect(of(c, 'pong')).toHaveLength(1));
    source.publish(['BTCUSDT', 1]);
    c.send({ t: 'ping' });
    await vi.waitFor(() => expect(of(c, 'pong')).toHaveLength(2));
    expect(of(c, 'tick')).toHaveLength(0);
  });

  it('answers ping with pong', async () => {
    const c = await opened(connect());
    c.send({ t: 'ping' });
    await vi.waitFor(() => expect(c.frames).toEqual([{ t: 'pong' }]));
  });

  it('sends stale on sub for a stale asset and forwards stale changes', async () => {
    source.stale.add('ADAUSDT');
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['ADAUSDT', 'BTCUSDT'] });
    await vi.waitFor(() => expect(of(c, 'stale')).toEqual([{ t: 'stale', s: 'ADAUSDT', on: true }]));
    source.setStale('BTCUSDT', true);
    source.setStale('SOLUSDT', true); // not subscribed
    source.setStale('ADAUSDT', false);
    await vi.waitFor(() =>
      expect(of(c, 'stale')).toEqual([
        { t: 'stale', s: 'ADAUSDT', on: true },
        { t: 'stale', s: 'BTCUSDT', on: true },
        { t: 'stale', s: 'ADAUSDT', on: false },
      ]),
    );
  });

  it('rejects unknown assets but subscribes the known ones', async () => {
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['BTCUSDT', 'NOPEUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    expect(of(c, 'error')).toEqual([
      { t: 'error', code: 'unknown_asset', message: 'Ativo desconhecido ou desativado.', assets: ['NOPEUSDT'] },
    ]);
  });

  it('enforces the per-connection asset limit all-or-nothing', async () => {
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
    await start({ maxAssetsPerConnection: 2 });
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['BTCUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    c.send({ t: 'sub', assets: ['ETHUSDT', 'SOLUSDT'] });
    await vi.waitFor(() => expect(of(c, 'error')).toHaveLength(1));
    expect(of(c, 'error')[0]).toMatchObject({ code: 'too_many_assets', assets: ['ETHUSDT', 'SOLUSDT'] });
    source.publish(['ETHUSDT', 1], ['BTCUSDT', 2]);
    await vi.waitFor(() => expect(of(c, 'tick')).toHaveLength(1));
    expect(of(c, 'tick')[0]?.data[0]?.s).toBe('BTCUSDT');
  });

  it(`rejects more than ${WS_MAX_ASSETS_PER_CONNECTION} assets in one message`, async () => {
    const c = await opened(connect());
    c.send({ t: 'sub', assets: Array.from({ length: WS_MAX_ASSETS_PER_CONNECTION + 1 }, (_, i) => `A${i}USDT`) });
    await vi.waitFor(() => expect(of(c, 'error')).toHaveLength(1));
    expect(of(c, 'error')[0]).toMatchObject({ code: 'bad_message', message: `No máximo ${WS_MAX_ASSETS_PER_CONNECTION} ativos por conexão.` });
  });

  it.each([
    ['not JSON', '{oops'],
    ['unknown type', { t: 'buy' }],
    ['bad symbol', { t: 'sub', assets: ['BTC/USDT'] }],
    ['empty list', { t: 'sub', assets: [] }],
  ])('answers %s with an error frame and keeps the connection', async (_n, msg) => {
    const c = await opened(connect());
    c.send(msg);
    await vi.waitFor(() => expect(of(c, 'error')).toHaveLength(1));
    expect(of(c, 'error')[0]?.code).toBe('bad_message');
    c.send({ t: 'ping' });
    await vi.waitFor(() => expect(of(c, 'pong')).toHaveLength(1));
  });

  it('closes a client that floods messages with 4429', async () => {
    const c = await opened(connect());
    for (let i = 0; i < 30; i++) c.send({ t: 'ping' });
    expect(await c.closed).toMatchObject({ code: 4429 });
  });

  it('drops subscriptions to an asset that gets disabled and marks it stale', async () => {
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['BTCUSDT', 'ADAUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    source.changeAssets(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    await vi.waitFor(() => expect(of(c, 'stale')).toEqual([{ t: 'stale', s: 'ADAUSDT', on: true }]));
    expect(metrics.render()).not.toContain('ws_subscriptions{symbol="ADAUSDT"}');
  });
});

describe('liveness and sessions', () => {
  it('pings clients and terminates one that never answers', async () => {
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
    await start({ heartbeatMs: 50, deadAfterMs: 150 });
    const alive = await opened(connect({ cookie: 'sid=u1:s1' }));
    const dead = await opened(connect({ cookie: 'sid=u2:s2', autoPong: false }));
    let pings = 0;
    alive.ws.on('ping', () => (pings += 1));
    expect((await dead.closed).code).toBe(1006);
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    expect(metrics.render()).toContain('ws_dead_connections_total 1');
  });

  it('closes connections whose session was revoked with 4401', async () => {
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
    await start({ revalidateMs: 50 });
    const keep = await opened(connect({ cookie: 'sid=u1:s1' }));
    const gone = await opened(connect({ cookie: 'sid=u2:s2' }));
    sessions.revoked.add('s2');
    expect(await gone.closed).toMatchObject({ code: 4401, reason: 'session ended' });
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes every client with 1001 on shutdown', async () => {
    const c = await opened(connect());
    const closing = gateway.close();
    expect(await c.closed).toMatchObject({ code: 1001 });
    await closing;
    expect(await upgradeStatus({})).toBe(404);
  });
});

describe('metrics', () => {
  it('counts connections, subscriptions and frames', async () => {
    const c = await opened(connect());
    c.send({ t: 'sub', assets: ['BTCUSDT'] });
    await vi.waitFor(() => expect(of(c, 'snapshot')).toHaveLength(1));
    source.publish(['BTCUSDT', 1]);
    await vi.waitFor(() => expect(of(c, 'tick')).toHaveLength(1));
    const text = metrics.render();
    expect(text).toContain('ws_connections 1');
    expect(text).toContain('ws_subscriptions{symbol="BTCUSDT"} 1');
    expect(text).toContain('ws_frames_sent_total{type="tick"} 1');
    expect(text).toContain('ws_frames_sent_total{type="snapshot"} 1');
  });
});
