import { beforeEach, describe, expect, it } from 'vitest';
import { backoffDelay, defaultFeedUrl, PriceFeed, type SocketLike, type Timers } from './feed';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

/** Manual clock: timers fire only when `advance` passes their due time. */
class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn, every: null });
    return id;
  }
  setInterval(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearTimeout(id: unknown) {
    this.tasks.delete(id as number);
  }
  clearInterval(id: unknown) {
    this.tasks.delete(id as number);
  }
  pendingTimeouts(): number[] {
    return [...this.tasks.values()].filter((t) => t.every === null).map((t) => t.at - this.now);
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next;
      this.now = t.at;
      if (t.every === null) this.tasks.delete(id);
      else t.at += t.every;
      t.fn();
    }
    this.now = end;
  }
}

let sockets: FakeSocket[];
let timers: FakeTimers;
let feed: PriceFeed;

const last = () => sockets.at(-1) as FakeSocket;

beforeEach(() => {
  sockets = [];
  timers = new FakeTimers();
  feed = new PriceFeed({
    url: 'ws://test/ws',
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => timers.now,
    random: () => 0.5,
    timers,
    localStaleMs: 4000,
    heartbeatMs: 20_000,
    deadAfterMs: 40_000,
  });
});

describe('backoff and url', () => {
  it('uses equal jitter capped at max', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 0.5)).toBe(6000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it('derives ws/wss from the page', () => {
    expect(defaultFeedUrl({ protocol: 'https:', host: 'app.example.com' })).toBe('wss://app.example.com/ws');
    expect(defaultFeedUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });
});

describe('PriceFeed', () => {
  it('subscribes on open with every referenced symbol, once each', () => {
    const offA = feed.subscribe('BTCUSDT', () => {});
    feed.subscribe('BTCUSDT', () => {});
    feed.subscribe('ETHUSDT', () => {});
    feed.start();
    expect(feed.getStatus()).toBe('connecting');
    last().open();
    expect(feed.getStatus()).toBe('open');
    expect(last().sent).toEqual([{ t: 'sub', assets: ['BTCUSDT', 'ETHUSDT'] }]);
    offA();
    expect(last().sent).toHaveLength(1);
    feed.subscribe('SOLUSDT', () => {});
    expect(last().sent.at(-1)).toEqual({ t: 'sub', assets: ['SOLUSDT'] });
  });

  it('unsubscribes when the last listener leaves', () => {
    feed.start();
    last().open();
    const off1 = feed.subscribe('BTCUSDT', () => {});
    const off2 = feed.subscribe('BTCUSDT', () => {});
    off1();
    off1();
    expect(last().sent).toEqual([{ t: 'sub', assets: ['BTCUSDT'] }]);
    off2();
    expect(last().sent.at(-1)).toEqual({ t: 'unsub', assets: ['BTCUSDT'] });
  });

  it('applies snapshot and ticks, dropping out-of-order seq', () => {
    let calls = 0;
    feed.subscribe('BTCUSDT', () => calls++);
    feed.subscribe('ADAUSDT', () => {});
    feed.start();
    last().open();
    last().frame({ t: 'snapshot', seq: 10, data: [{ s: 'BTCUSDT', p: 100, ts: 1 }] });
    expect(feed.quote('BTCUSDT')).toEqual({ price: 100, ts: 1, stale: false });
    // Subscribed but missing from the snapshot: unknown, so not tradeable.
    expect(feed.quote('ADAUSDT')).toEqual({ price: null, ts: 0, stale: true });
    last().frame({ t: 'tick', seq: 12, data: [{ s: 'BTCUSDT', p: 101, ts: 2 }] });
    last().frame({ t: 'tick', seq: 11, data: [{ s: 'BTCUSDT', p: 99, ts: 3 }] });
    last().frame({ t: 'tick', seq: 12, data: [{ s: 'BTCUSDT', p: 98, ts: 4 }] });
    expect(feed.quote('BTCUSDT')?.price).toBe(101);
    expect(calls).toBe(2);
    // Symbols nobody asked for are ignored.
    last().frame({ t: 'tick', seq: 13, data: [{ s: 'XRPUSDT', p: 1, ts: 5 }] });
    expect(feed.quote('XRPUSDT')).toBeNull();
  });

  it('follows stale frames and error frames', () => {
    feed.subscribe('BTCUSDT', () => {});
    feed.subscribe('FOOUSDT', () => {});
    feed.start();
    last().open();
    last().frame({
      t: 'snapshot',
      seq: 1,
      data: [
        { s: 'BTCUSDT', p: 100, ts: 1 },
        { s: 'FOOUSDT', p: 5, ts: 1 },
      ],
    });
    last().frame({ t: 'stale', s: 'BTCUSDT', on: true });
    expect(feed.quote('BTCUSDT')).toEqual({ price: 100, ts: 1, stale: true });
    last().frame({ t: 'stale', s: 'BTCUSDT', on: false });
    expect(feed.quote('BTCUSDT')?.stale).toBe(false);
    last().frame({ t: 'error', code: 'unknown_asset', message: 'x', assets: ['FOOUSDT'] });
    expect(feed.quote('FOOUSDT')?.stale).toBe(true);
    last().frame('not json at all');
    expect(feed.getStatus()).toBe('open');
  });

  it('marks quotes stale locally when updates stop', () => {
    feed.subscribe('BTCUSDT', () => {});
    feed.start();
    last().open();
    last().frame({ t: 'snapshot', seq: 1, data: [{ s: 'BTCUSDT', p: 100, ts: 1 }] });
    timers.advance(4000);
    expect(feed.quote('BTCUSDT')?.stale).toBe(false);
    timers.advance(1000);
    expect(feed.quote('BTCUSDT')?.stale).toBe(true);
  });

  it('reconnects with backoff, resets seq per connection and resubscribes', () => {
    feed.subscribe('BTCUSDT', () => {});
    feed.start();
    last().open();
    last().frame({ t: 'snapshot', seq: 500, data: [{ s: 'BTCUSDT', p: 100, ts: 1 }] });
    last().serverClose(1001);
    expect(feed.getStatus()).toBe('reconnecting');
    expect(feed.quote('BTCUSDT')?.stale).toBe(true);
    expect(timers.pendingTimeouts()).toEqual([750]);
    timers.advance(750);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().sent).toEqual([{ t: 'sub', assets: ['BTCUSDT'] }]);
    // Restarted gateway: seq starts low again and must be accepted.
    last().frame({ t: 'snapshot', seq: 1, data: [{ s: 'BTCUSDT', p: 102, ts: 2 }] });
    expect(feed.quote('BTCUSDT')).toEqual({ price: 102, ts: 2, stale: false });
  });

  it('grows the delay while connections keep failing and resets after prices arrive', () => {
    feed.start();
    last().serverClose(1006);
    expect(timers.pendingTimeouts()).toEqual([750]);
    timers.advance(750);
    last().serverClose(1006);
    expect(timers.pendingTimeouts()).toEqual([1500]);
    timers.advance(1500);
    last().open();
    last().frame({ t: 'tick', seq: 1, data: [] });
    last().serverClose(1006);
    expect(timers.pendingTimeouts()).toEqual([750]);
  });

  it('stops on 4401 and waits longer on 4409', () => {
    feed.start();
    last().serverClose(4409);
    expect(timers.pendingTimeouts()).toEqual([10_000]);
    timers.advance(10_000);
    last().serverClose(4401);
    expect(feed.getStatus()).toBe('unauthorized');
    expect(timers.pendingTimeouts()).toEqual([]);
    feed.start();
    expect(sockets).toHaveLength(3);
  });

  it('pings on the heartbeat and drops a silent link', () => {
    feed.start();
    last().open();
    timers.advance(20_000);
    expect(last().sent).toEqual([{ t: 'ping' }]);
    last().frame({ t: 'pong' });
    timers.advance(40_000);
    expect(sockets).toHaveLength(1);
    timers.advance(1000);
    expect(sockets[0]?.closedWith).toBe(4000);
    expect(feed.getStatus()).toBe('reconnecting');
  });

  it('notifies status listeners and stops cleanly', () => {
    const seen: string[] = [];
    feed.onStatus(() => seen.push(feed.getStatus()));
    feed.start();
    last().open();
    feed.stop();
    expect(seen).toEqual(['connecting', 'open', 'stopped']);
    expect(last().closedWith).toBe(1000);
    timers.advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});
