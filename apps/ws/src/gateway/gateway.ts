import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientFrameSchema,
  WS_DEAD_AFTER_MS,
  WS_HEARTBEAT_MS,
  WS_MAX_ASSETS_PER_CONNECTION,
  WS_MAX_CONNECTIONS_PER_USER,
  WS_MAX_MESSAGE_BYTES,
  WS_PATH,
  WsCloseCode,
  WsErrorCode,
  type ErrorFrame,
  type PriceItem,
  type SnapshotFrame,
  type WsPresenceEntry,
} from '@traderoom/shared';
import type { PublishedPrice, SeqCounter } from '../feed/conflator.js';
import { staleFrame } from '../feed/conflator.js';
import type { RelayListener } from '../feed/relay.js';
import type { StaleChange } from '../feed/stale-tracker.js';
import type { FeedAsset, Tick } from '../feed/types.js';
import type { Logger } from '../lib/log.js';
import type { Counter, Registry } from '../lib/metrics.js';
import type { SessionStore, WsSession } from './session.js';

/** What the gateway needs from the relay (the Relay class implements it). */
export interface PriceSource {
  listen(l: RelayListener): () => void;
  latest(symbol: string): Tick | undefined;
  isStale(symbol: string): boolean;
  assets(): readonly FeedAsset[];
  seqCounter(): SeqCounter;
}

export interface GatewayOptions {
  /** Browser Origin allowed to connect (the app's public origin). Requests without Origin are allowed. */
  allowedOrigin: string;
  heartbeatMs: number;
  deadAfterMs: number;
  /** How often open connections re-check their session (logout, block, expiry). */
  revalidateMs: number;
  maxAssetsPerConnection: number;
  maxConnectionsPerUser: number;
  /** Client messages allowed per second before the connection is closed. */
  maxMessagesPerSec: number;
  /** Skip tick frames for a client whose send buffer is above this (it will get the next one). */
  dropTicksAboveBytes: number;
  /** Terminate a client whose send buffer is above this (it is not reading at all). */
  terminateAboveBytes: number;
  /** Concurrent handshakes waiting on the session lookup; more get 503. */
  maxPendingAuth: number;
}

export const GATEWAY_DEFAULTS: Omit<GatewayOptions, 'allowedOrigin'> = {
  heartbeatMs: WS_HEARTBEAT_MS,
  deadAfterMs: WS_DEAD_AFTER_MS,
  revalidateMs: 60_000,
  maxAssetsPerConnection: WS_MAX_ASSETS_PER_CONNECTION,
  maxConnectionsPerUser: WS_MAX_CONNECTIONS_PER_USER,
  maxMessagesPerSec: 20,
  dropTicksAboveBytes: 256 * 1024,
  terminateAboveBytes: 4 * 1024 * 1024,
  maxPendingAuth: 200,
};

interface GatewayCounters {
  opened: Counter;
  closed: Counter;
  rejected: Counter;
  dead: Counter;
  framesSent: Counter;
  framesDropped: Counter;
  slowTerminated: Counter;
  messages: Counter;
}

interface Client {
  ws: WebSocket;
  session: WsSession;
  subs: Set<string>;
  /** Epoch ms when the connection was accepted. */
  openedAt: number;
  lastSeen: number;
  msgWindowStart: number;
  msgCount: number;
}

const PONG = Buffer.from(JSON.stringify({ t: 'pong' }));
const TEXT = { binary: false } as const;

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * WebSocket gateway on `/ws`: authenticates with the session cookie, lets each
 * client subscribe to up to 20 assets and fans out the relay's pre-serialized frames.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly bySymbol = new Map<string, Set<Client>>();
  private readonly byUser = new Map<string, Set<Client>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly unlisten: () => void;
  private readonly now: () => number;
  private pendingAuth = 0;
  private closing = false;
  private revalidating = false;
  private readonly m: GatewayCounters;

  constructor(
    private readonly server: Server,
    private readonly source: PriceSource,
    private readonly sessions: SessionStore,
    private readonly opts: GatewayOptions,
    private readonly deps: { log: Logger; metrics: Registry; now?: () => number },
  ) {
    this.now = deps.now ?? Date.now;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES, perMessageDeflate: false });

    const reg = deps.metrics;
    this.m = {
      opened: reg.counter('ws_connections_opened_total', 'Accepted WebSocket connections.'),
      closed: reg.counter('ws_connections_closed_total', 'Closed WebSocket connections, by close code.'),
      rejected: reg.counter('ws_handshakes_rejected_total', 'Handshakes rejected, by reason.'),
      dead: reg.counter('ws_dead_connections_total', 'Connections terminated by the heartbeat.'),
      framesSent: reg.counter('ws_frames_sent_total', 'Frames sent to clients, by type.'),
      framesDropped: reg.counter('ws_frames_dropped_total', 'Tick frames skipped for slow clients.'),
      slowTerminated: reg.counter('ws_slow_clients_terminated_total', 'Clients terminated for not reading.'),
      messages: reg.counter('ws_client_messages_total', 'Messages from clients, by type.'),
    };
    reg.gauge('ws_connections', 'Open WebSocket connections.', () => [[{}, this.clients.size]]);
    reg.gauge('ws_users', 'Distinct users connected.', () => [[{}, this.byUser.size]]);
    reg.gauge('ws_subscriptions', 'Subscribers per symbol.', () =>
      [...this.bySymbol].map(([symbol, set]) => [{ symbol }, set.size] as const),
    );

    server.on('upgrade', this.onUpgrade);
    this.unlisten = source.listen({
      onPrices: (p) => this.fanOutPrices(p),
      onStale: (c, frame) => this.fanOutStale(c, frame),
      onAssets: (a) => this.onAssetsChanged(a),
    });
    this.timers.push(setInterval(() => this.heartbeat(), opts.heartbeatMs));
    this.timers.push(setInterval(() => void this.revalidate(), opts.revalidateMs));
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** Users connected right now, one entry per user (for the admin's "online" list). */
  presence(): WsPresenceEntry[] {
    const out: WsPresenceEntry[] = [];
    for (const [userId, conns] of this.byUser) {
      let since = Infinity;
      const assets = new Set<string>();
      for (const c of conns) {
        since = Math.min(since, c.openedAt);
        for (const s of c.subs) assets.add(s);
      }
      out.push({ userId, connections: conns.size, since, assets: [...assets].sort() });
    }
    return out;
  }

  /** Closes every client with 1001 and stops accepting new ones. */
  async close(): Promise<void> {
    this.closing = true;
    this.server.off('upgrade', this.onUpgrade);
    for (const t of this.timers) clearInterval(t);
    this.unlisten();
    const closed = [...this.clients].map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.ws.readyState === WebSocket.CLOSED) return resolve();
          const t = setTimeout(() => {
            c.ws.terminate();
            resolve();
          }, 2000);
          c.ws.once('close', () => {
            clearTimeout(t);
            resolve();
          });
          c.ws.close(WsCloseCode.GoingAway, 'server restarting');
        }),
    );
    await Promise.all(closed);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ---- Handshake ----

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      this.m.rejected.inc({ reason: 'not_found' });
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (this.closing) {
      this.m.rejected.inc({ reason: 'closing' });
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    // Browsers always send Origin; a foreign one means a cross-site page is trying to ride the cookie.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.opts.allowedOrigin) {
      this.m.rejected.inc({ reason: 'origin' });
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (this.pendingAuth >= this.opts.maxPendingAuth) {
      this.m.rejected.inc({ reason: 'busy' });
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    this.pendingAuth += 1;
    socket.on('error', () => socket.destroy());
    this.sessions
      .resolve(req.headers.cookie)
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'session lookup failed during ws handshake');
        return null;
      })
      .then((session) => {
        this.pendingAuth -= 1;
        if (socket.destroyed) return;
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, session));
      })
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'ws upgrade failed');
        socket.destroy();
      });
  };

  private onConnection(ws: WebSocket, session: WsSession | null): void {
    ws.on('error', (err) => this.deps.log.debug({ err: err.message }, 'ws client error'));
    if (!session) {
      this.m.rejected.inc({ reason: 'unauthorized' });
      ws.close(WsCloseCode.Unauthorized, 'unauthorized');
      return;
    }
    if (this.closing) {
      ws.close(WsCloseCode.GoingAway, 'server restarting');
      return;
    }
    const userConns = this.byUser.get(session.userId);
    if (userConns && userConns.size >= this.opts.maxConnectionsPerUser) {
      this.m.rejected.inc({ reason: 'too_many_connections' });
      ws.close(WsCloseCode.TooManyConnections, 'too many connections');
      return;
    }

    const now = this.now();
    const client: Client = { ws, session, subs: new Set(), openedAt: now, lastSeen: now, msgWindowStart: now, msgCount: 0 };
    this.clients.add(client);
    if (userConns) userConns.add(client);
    else this.byUser.set(session.userId, new Set([client]));
    this.m.opened.inc();

    ws.on('pong', () => {
      client.lastSeen = this.now();
    });
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', (code) => this.onClose(client, code));
  }

  private onClose(client: Client, code: number): void {
    if (!this.clients.delete(client)) return;
    this.m.closed.inc({ code: String(code) });
    for (const s of client.subs) this.removeSub(client, s);
    const userConns = this.byUser.get(client.session.userId);
    userConns?.delete(client);
    if (userConns?.size === 0) this.byUser.delete(client.session.userId);
  }

  // ---- Client messages ----

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    const now = this.now();
    client.lastSeen = now;
    if (now - client.msgWindowStart >= 1000) {
      client.msgWindowStart = now;
      client.msgCount = 0;
    }
    client.msgCount += 1;
    if (client.msgCount > this.opts.maxMessagesPerSec) {
      this.m.messages.inc({ type: 'rate_limited' });
      client.ws.close(WsCloseCode.RateLimited, 'rate limited');
      return;
    }

    if (isBinary || rawLength(data) > WS_MAX_MESSAGE_BYTES) {
      this.m.messages.inc({ type: 'invalid' });
      this.sendError(client, { t: 'error', code: WsErrorCode.BadMessage, message: 'Mensagem inválida.' });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(toText(data));
    } catch {
      json = undefined;
    }
    const parsed = ClientFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.m.messages.inc({ type: 'invalid' });
      const issue = parsed.error.issues[0];
      this.sendError(client, {
        t: 'error',
        code: WsErrorCode.BadMessage,
        message: issue?.message && issue.code === 'too_big' ? issue.message : 'Mensagem inválida.',
      });
      return;
    }

    const frame = parsed.data;
    this.m.messages.inc({ type: frame.t });
    switch (frame.t) {
      case 'ping':
        this.send(client, PONG, 'pong');
        return;
      case 'unsub':
        for (const s of frame.assets) this.removeSub(client, s);
        return;
      case 'sub':
        this.subscribe(client, frame.assets);
        return;
    }
  }

  private subscribe(client: Client, requested: readonly string[]): void {
    const known = new Set(this.source.assets().map((a) => a.symbol));
    const unique = [...new Set(requested)];
    const unknown = unique.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.sendError(client, {
        t: 'error',
        code: WsErrorCode.UnknownAsset,
        message: 'Ativo desconhecido ou desativado.',
        assets: unknown,
      });
    }
    const fresh = unique.filter((s) => known.has(s) && !client.subs.has(s));
    if (fresh.length === 0) return;
    // All-or-nothing, so the client's view of its subscriptions never drifts.
    if (client.subs.size + fresh.length > this.opts.maxAssetsPerConnection) {
      this.sendError(client, {
        t: 'error',
        code: WsErrorCode.TooManyAssets,
        message: `No máximo ${this.opts.maxAssetsPerConnection} ativos por conexão.`,
        assets: fresh,
      });
      return;
    }

    const data: PriceItem[] = [];
    for (const s of fresh) {
      client.subs.add(s);
      let set = this.bySymbol.get(s);
      if (!set) {
        set = new Set();
        this.bySymbol.set(s, set);
      }
      set.add(client);
      const t = this.source.latest(s);
      if (t) data.push(t.ov ? { s, p: t.value, ts: t.ts, ov: t.ov } : { s, p: t.value, ts: t.ts });
    }
    // The snapshot takes its seq now, so every later tick on this connection has a higher one.
    const snapshot: SnapshotFrame = { t: 'snapshot', seq: this.source.seqCounter().next(), data };
    this.send(client, Buffer.from(JSON.stringify(snapshot)), 'snapshot');
    for (const s of fresh) if (this.source.isStale(s)) this.send(client, staleFrame(s, true), 'stale');
  }

  private removeSub(client: Client, symbol: string): void {
    if (!client.subs.delete(symbol)) return;
    const set = this.bySymbol.get(symbol);
    set?.delete(client);
    if (set?.size === 0) this.bySymbol.delete(symbol);
  }

  // ---- Fan-out ----

  private fanOutPrices(prices: readonly PublishedPrice[]): void {
    for (const p of prices) {
      const set = this.bySymbol.get(p.tick.symbol);
      if (!set) continue;
      for (const c of set) {
        if (c.ws.bufferedAmount > this.opts.dropTicksAboveBytes) {
          this.m.framesDropped.inc();
          this.checkSlow(c);
          continue;
        }
        this.send(c, p.frame, 'tick');
      }
    }
  }

  private fanOutStale(change: StaleChange, frame: Buffer): void {
    const set = this.bySymbol.get(change.symbol);
    if (!set) return;
    // Stale changes are never dropped: they gate order buttons in the UI.
    for (const c of set) this.send(c, frame, 'stale');
  }

  private onAssetsChanged(assets: readonly FeedAsset[]): void {
    const enabled = new Set(assets.map((a) => a.symbol));
    for (const [symbol, set] of [...this.bySymbol]) {
      if (enabled.has(symbol)) continue;
      const frame = staleFrame(symbol, true);
      for (const c of [...set]) {
        this.send(c, frame, 'stale');
        this.removeSub(c, symbol);
      }
    }
  }

  private send(c: Client, frame: Buffer, type: string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if (this.checkSlow(c)) return;
    // Text frames: the browser gets a string, not a Blob. The Buffer is shared, never copied per client.
    c.ws.send(frame, TEXT);
    this.m.framesSent.inc({ type });
  }

  private sendError(c: Client, frame: ErrorFrame): void {
    this.send(c, Buffer.from(JSON.stringify(frame)), 'error');
  }

  /** Terminates a client that stopped reading; returns true if it did. */
  private checkSlow(c: Client): boolean {
    if (c.ws.bufferedAmount <= this.opts.terminateAboveBytes) return false;
    this.m.slowTerminated.inc();
    this.deps.log.warn({ userId: c.session.userId, buffered: c.ws.bufferedAmount }, 'terminating slow ws client');
    c.ws.terminate();
    return true;
  }

  // ---- Liveness and session checks ----

  private heartbeat(): void {
    const now = this.now();
    for (const c of this.clients) {
      if (now - c.lastSeen > this.opts.deadAfterMs) {
        this.m.dead.inc();
        c.ws.terminate();
        continue;
      }
      if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
    }
  }

  private async revalidate(): Promise<void> {
    if (this.revalidating || this.clients.size === 0) return;
    this.revalidating = true;
    try {
      const ids = [...new Set([...this.clients].map((c) => c.session.sessionId))];
      const valid = await this.sessions.stillValid(ids);
      for (const c of [...this.clients]) {
        if (!valid.has(c.session.sessionId)) c.ws.close(WsCloseCode.Unauthorized, 'session ended');
      }
    } catch (err) {
      // Keep connections open on a DB blip; the next round retries.
      this.deps.log.error({ err }, 'ws session revalidation failed');
    } finally {
      this.revalidating = false;
    }
  }
}
