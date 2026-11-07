import { WebSocket, type RawData } from 'ws';
import type { Backoff } from '../lib/backoff.js';
import type { Logger } from '../lib/log.js';
import type { FeedProvider, ProviderSpec, Tick } from './types.js';

export interface FeedConnectionOptions {
  name: FeedProvider;
  /** Called on every (re)connect, so asset changes are picked up. Null means "nothing to subscribe". */
  spec: () => ProviderSpec | null;
  onTick: (tick: Tick) => void;
  /** Called after every unplanned disconnect, before the retry is scheduled. */
  onReconnect?: (info: { delayMs: number; attempt: number; reason: string }) => void;
  onStateChange?: (connected: boolean) => void;
  backoff: Backoff;
  log: Logger;
  /** Terminate and reconnect when no message arrives for this long (half-open sockets). */
  idleTimeoutMs: number;
  handshakeTimeoutMs?: number;
  now?: () => number;
}

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** A single provider socket that reconnects forever until `stop()`. */
export class FeedConnection {
  private ws: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private restartRequested = false;
  /** True once the current socket delivered a valid tick; resets the backoff. */
  private healthy = false;
  private isConnected = false;
  private readonly now: () => number;

  constructor(private readonly opts: FeedConnectionOptions) {
    this.now = opts.now ?? Date.now;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Drops the socket and connects again right away (used when the asset list changes). */
  restart(): void {
    if (this.stopped) return;
    this.opts.backoff.reset();
    if (this.ws) {
      this.restartRequested = true;
      this.ws.terminate();
      return;
    }
    this.clearRetry();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    this.clearIdle();
    const ws = this.ws;
    this.ws = null;
    this.setConnected(false);
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.terminate();
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const spec = this.opts.spec();
    if (!spec) {
      this.opts.log.info({ provider: this.opts.name }, 'feed has nothing to subscribe; staying idle');
      return;
    }
    this.healthy = false;
    const ws = new WebSocket(spec.url, {
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? 10_000,
      perMessageDeflate: false,
    });
    this.ws = ws;
    this.armIdle(ws);

    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.setConnected(true);
      this.opts.log.info({ provider: spec.name, url: spec.url }, 'feed connected');
      for (const m of spec.onOpenMessages) ws.send(m);
      this.armIdle(ws);
    });

    ws.on('message', (data) => {
      if (ws !== this.ws) return;
      this.armIdle(ws);
      const result = spec.parse(toText(data), this.now());
      if (result.kind === 'tick') {
        if (!this.healthy) {
          this.healthy = true;
          this.opts.backoff.reset();
        }
        this.opts.onTick(result.tick);
      } else if (result.kind === 'error') {
        this.opts.log.warn({ provider: spec.name, error: result.message }, 'feed message error');
      }
    });

    ws.on('error', (err) => {
      // A 'close' event always follows; reconnect happens there.
      this.opts.log.warn({ provider: spec.name, err: err.message }, 'feed socket error');
    });

    ws.on('close', (code, reason) => {
      this.onClosed(ws, `close ${code}${reason.length > 0 ? ` ${reason.toString('utf8')}` : ''}`);
    });
  }

  private onClosed(ws: WebSocket, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearIdle();
    this.setConnected(false);
    if (this.stopped) return;

    if (this.restartRequested) {
      this.restartRequested = false;
      this.opts.log.info({ provider: this.opts.name }, 'feed restarting with new subscriptions');
      this.connect();
      return;
    }

    const attempt = this.opts.backoff.attempts + 1;
    const delayMs = this.opts.backoff.next();
    this.opts.log.warn({ provider: this.opts.name, reason, attempt, delayMs }, 'feed disconnected; reconnecting');
    this.opts.onReconnect?.({ delayMs, attempt, reason });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delayMs);
  }

  private armIdle(ws: WebSocket): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (ws !== this.ws) return;
      this.opts.log.warn({ provider: this.opts.name, idleMs: this.opts.idleTimeoutMs }, 'feed silent; terminating socket');
      ws.terminate();
    }, this.opts.idleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setConnected(v: boolean): void {
    if (this.isConnected === v) return;
    this.isConnected = v;
    this.opts.onStateChange?.(v);
  }
}
