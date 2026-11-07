import {
  FEED_STALE_MS,
  WS_DEAD_AFTER_MS,
  WS_HEARTBEAT_MS,
  WS_PATH,
  WsCloseCode,
  type ClientFrame,
  type PriceItem,
  type ServerFrame,
} from '@traderoom/shared';

export type FeedStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'stopped';

/** Latest known price for a symbol. `price` is null until the first one arrives. */
export interface Quote {
  price: number | null;
  /** Price time from the feed, epoch ms (0 when unknown). */
  ts: number;
  stale: boolean;
}

/** The subset of the browser WebSocket the feed uses, so tests can inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface FeedOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  random?: () => number;
  timers?: Timers;
  /** A quote with no update for this long is flagged stale locally (the server also sends `stale`). */
  localStaleMs?: number;
  heartbeatMs?: number;
  deadAfterMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Minimum wait after a 4409 (too many connections from this user). */
  tooManyDelayMs?: number;
}

const OPEN = 1;
const CHECK_EVERY_MS = 1000;

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as number),
};

/** Equal jitter: half the capped exponential delay is fixed, the other half random. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(capped / 2 + random() * (capped / 2));
}

export function defaultFeedUrl(loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${WS_PATH}`;
}

/**
 * One WebSocket to the gateway shared by the whole app. Components subscribe per symbol
 * (ref-counted); the feed keeps the subscription set across reconnects, drops frames whose
 * seq is not above the last one on the current connection, and marks every quote stale while
 * disconnected so trading is blocked until fresh prices arrive.
 */
export class PriceFeed {
  private readonly o: Required<Omit<FeedOptions, 'createSocket'>> & Pick<FeedOptions, 'createSocket'>;
  private socket: SocketLike | null = null;
  private status: FeedStatus = 'stopped';
  private attempt = 0;
  private lastSeq = Number.NEGATIVE_INFINITY;
  private lastFrameAt = 0;
  private lastPingAt = 0;
  private reconnectTimer: unknown = null;
  private checkTimer: unknown = null;
  private readonly refs = new Map<string, number>();
  private readonly quotes = new Map<string, Quote>();
  private readonly receivedAt = new Map<string, number>();
  private readonly quoteListeners = new Map<string, Set<() => void>>();
  private readonly statusListeners = new Set<() => void>();

  constructor(opts: FeedOptions) {
    this.o = {
      now: Date.now,
      random: Math.random,
      timers: browserTimers,
      localStaleMs: FEED_STALE_MS + 2000,
      heartbeatMs: WS_HEARTBEAT_MS,
      deadAfterMs: WS_DEAD_AFTER_MS,
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      tooManyDelayMs: 10_000,
      ...opts,
    };
  }

  start(): void {
    if (this.status !== 'stopped' && this.status !== 'unauthorized') return;
    this.attempt = 0;
    this.connect('connecting');
    this.checkTimer ??= this.o.timers.setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    this.clearReconnect();
    if (this.checkTimer !== null) this.o.timers.clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.dropSocket(1000, 'client stop');
    this.markAllStale();
    this.setStatus('stopped');
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  quote(symbol: string): Quote | null {
    return this.quotes.get(symbol) ?? null;
  }

  /** Subscribes to a symbol; call the returned function to release it. */
  subscribe(symbol: string, listener: () => void): () => void {
    let set = this.quoteListeners.get(symbol);
    if (!set) this.quoteListeners.set(symbol, (set = new Set()));
    set.add(listener);
    const count = (this.refs.get(symbol) ?? 0) + 1;
    this.refs.set(symbol, count);
    if (count === 1) this.sendFrame({ t: 'sub', assets: [symbol] });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      set.delete(listener);
      if (set.size === 0) this.quoteListeners.delete(symbol);
      const left = (this.refs.get(symbol) ?? 1) - 1;
      if (left > 0) {
        this.refs.set(symbol, left);
        return;
      }
      this.refs.delete(symbol);
      this.quotes.delete(symbol);
      this.receivedAt.delete(symbol);
      this.sendFrame({ t: 'unsub', assets: [symbol] });
    };
  }

  private connect(status: FeedStatus): void {
    this.clearReconnect();
    this.setStatus(status);
    const create = this.o.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = create(this.o.url);
    } catch {
      this.scheduleReconnect(0);
      return;
    }
    this.socket = socket;
    this.lastSeq = Number.NEGATIVE_INFINITY;
    this.lastFrameAt = this.o.now();
    this.lastPingAt = this.o.now();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.o.now();
      this.setStatus('open');
      const assets = [...this.refs.keys()];
      if (assets.length > 0) this.sendFrame({ t: 'sub', assets });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.o.now();
      if (typeof ev.data !== 'string') return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.afterClose(ev.code);
    };
    // Browsers always follow `error` with `close`, which does the work.
    socket.onerror = () => {};
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'snapshot':
      case 'tick': {
        if (frame.seq <= this.lastSeq) return;
        this.lastSeq = frame.seq;
        // A connection that delivers prices is healthy: the next failure starts backoff from scratch.
        this.attempt = 0;
        for (const item of frame.data) this.applyPrice(item);
        if (frame.t === 'snapshot') {
          // Subscribed symbols the server had no price for are unknown, hence not tradeable.
          for (const symbol of this.refs.keys()) {
            if (!this.quotes.has(symbol)) this.setQuote(symbol, { price: null, ts: 0, stale: true });
          }
        }
        return;
      }
      case 'stale': {
        const q = this.quotes.get(frame.s);
        if (!this.refs.has(frame.s)) return;
        if (!q || q.stale !== frame.on) this.setQuote(frame.s, { price: q?.price ?? null, ts: q?.ts ?? 0, stale: frame.on });
        if (!frame.on) this.receivedAt.set(frame.s, this.o.now());
        return;
      }
      case 'error': {
        for (const symbol of frame.assets ?? []) {
          if (!this.refs.has(symbol)) continue;
          const q = this.quotes.get(symbol);
          this.setQuote(symbol, { price: q?.price ?? null, ts: q?.ts ?? 0, stale: true });
        }
        return;
      }
      case 'pong':
        return;
    }
  }

  private applyPrice(item: PriceItem): void {
    if (!this.refs.has(item.s)) return;
    this.receivedAt.set(item.s, this.o.now());
    this.setQuote(item.s, { price: item.p, ts: item.ts, stale: false });
  }

  private afterClose(code: number): void {
    this.markAllStale();
    if (code === WsCloseCode.Unauthorized) {
      this.setStatus('unauthorized');
      return;
    }
    const delay = backoffDelay(this.attempt, this.o.backoffBaseMs, this.o.backoffMaxMs, this.o.random);
    this.attempt += 1;
    this.scheduleReconnect(code === WsCloseCode.TooManyConnections ? Math.max(delay, this.o.tooManyDelayMs) : delay);
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnect();
    this.setStatus('reconnecting');
    this.reconnectTimer = this.o.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect('reconnecting');
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.o.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Heartbeat, dead-link detection and the local stale guard. */
  private check(): void {
    const now = this.o.now();
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) {
      if (now - this.lastFrameAt > this.o.deadAfterMs) {
        // Detach first: on a dead link the browser may take minutes to fire `close`.
        this.dropSocket(4000, 'no traffic');
        this.afterClose(4000);
        return;
      }
      if (now - this.lastPingAt >= this.o.heartbeatMs) {
        this.lastPingAt = now;
        this.sendFrame({ t: 'ping' });
      }
    }
    for (const [symbol, q] of this.quotes) {
      const at = this.receivedAt.get(symbol);
      if (!q.stale && at !== undefined && now - at > this.o.localStaleMs) this.setQuote(symbol, { ...q, stale: true });
    }
  }

  private dropSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private markAllStale(): void {
    for (const [symbol, q] of this.quotes) if (!q.stale) this.setQuote(symbol, { ...q, stale: true });
  }

  private setQuote(symbol: string, q: Quote): void {
    this.quotes.set(symbol, q);
    for (const l of this.quoteListeners.get(symbol) ?? []) l();
  }

  private setStatus(s: FeedStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l();
  }
}
