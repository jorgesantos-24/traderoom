import { describe, expect, it } from 'vitest';
import { Conflator, SeqCounter, staleFrame } from '../src/feed/conflator.js';
import type { Tick } from '../src/feed/types.js';

function tick(symbol: string, price: string, ts: number): Tick {
  return { symbol, price, value: Number(price), ts, recvMs: ts + 5, provider: 'binance' };
}

describe('Conflator', () => {
  it('publishes only the newest tick per symbol in a window', () => {
    const c = new Conflator(new SeqCounter());
    c.push(tick('BTCUSDT', '100.10', 1));
    c.push(tick('BTCUSDT', '100.20', 2));
    c.push(tick('ETHUSDT', '50.00', 3));
    c.push(tick('BTCUSDT', '100.30', 4));
    expect(c.pendingCount).toBe(2);
    const out = c.flush();
    expect(out.map((p) => [p.tick.symbol, p.tick.price])).toEqual([
      ['BTCUSDT', '100.30'],
      ['ETHUSDT', '50.00'],
    ]);
    expect(c.pendingCount).toBe(0);
  });

  it('serializes the frame once, in the protocol shape', () => {
    const c = new Conflator(new SeqCounter());
    c.push(tick('BTCUSDT', '75553.10000000', 1_793_217_464_200));
    const [p] = c.flush();
    expect(Buffer.isBuffer(p?.frame)).toBe(true);
    expect(JSON.parse(p?.frame.toString() ?? '')).toEqual({
      t: 'tick',
      seq: 1,
      data: [{ s: 'BTCUSDT', p: 75553.1, ts: 1_793_217_464_200 }],
    });
  });

  it('returns nothing for an empty window', () => {
    const c = new Conflator(new SeqCounter());
    expect(c.flush()).toEqual([]);
    c.push(tick('BTCUSDT', '1', 1));
    c.flush();
    expect(c.flush()).toEqual([]);
  });

  it('keeps seq strictly increasing across windows and symbols', () => {
    const seq = new SeqCounter();
    const c = new Conflator(seq);
    const seqs: number[] = [];
    for (let w = 0; w < 5; w++) {
      c.push(tick('BTCUSDT', String(100 + w), w));
      c.push(tick('ETHUSDT', String(50 + w), w));
      for (const p of c.flush()) seqs.push((JSON.parse(p.frame.toString()) as { seq: number }).seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Snapshots (milestone 4) draw from the same counter.
    expect(seq.next()).toBe(11);
  });

  it('builds stale frames', () => {
    expect(JSON.parse(staleFrame('BTCUSDT', true).toString())).toEqual({ t: 'stale', s: 'BTCUSDT', on: true });
  });
});
