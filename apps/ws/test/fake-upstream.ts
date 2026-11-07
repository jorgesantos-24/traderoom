import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { pino } from 'pino';

export const silentLog = pino({ level: 'silent' });

/** A local WebSocket server standing in for a Binance endpoint. */
export class FakeUpstream {
  readonly received: string[] = [];
  readonly paths: string[] = [];
  connections = 0;
  /** When false, new connections are refused at the HTTP level (handshake fails). */
  accepting = true;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on('connection', (ws, req) => {
      this.connections += 1;
      this.paths.push(req.url ?? '');
      this.sockets.add(ws);
      ws.on('message', (m) => this.received.push(m.toString()));
      ws.on('close', () => this.sockets.delete(ws));
    });
  }

  static async start(): Promise<FakeUpstream> {
    let up: FakeUpstream | undefined;
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (_info, cb) => cb(up?.accepting ?? true, 503),
    });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    up = new FakeUpstream(wss);
    return up;
  }

  get url(): string {
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/stream`;
  }

  get open(): number {
    return this.sockets.size;
  }

  send(msg: unknown): void {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const ws of this.sockets) ws.send(raw);
  }

  /** Abruptly drops every client (like a network cut). */
  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function binanceTrade(symbol: string, price: string, ts = Date.now()): unknown {
  return {
    stream: `${symbol.toLowerCase()}@trade`,
    data: { e: 'trade', E: ts, s: symbol, t: 1, p: price, q: '0.1', T: ts },
  };
}

/** Binance spot bookTicker; the relay prices it at (bid + ask) / 2. */
export function binanceQuote(symbol: string, bid: string, ask: string = bid): unknown {
  return {
    stream: `${symbol.toLowerCase()}@bookTicker`,
    data: { u: 1, s: symbol, b: bid, B: '1.0', a: ask, A: '1.0' },
  };
}

/** Sends `make()` every `ms` until the returned stop function is called. */
export function pump(up: FakeUpstream, ms: number, make: () => unknown): () => void {
  const t = setInterval(() => up.send(make()), ms);
  return () => clearInterval(t);
}
