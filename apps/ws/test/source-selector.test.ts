import { describe, expect, it } from 'vitest';
import { SourceSelector } from '../src/feed/source-selector.js';
import type { FeedProvider, Tick } from '../src/feed/types.js';

const OPTS = { failoverMs: 5000, recoverStableMs: 60_000, gapMs: 2000 };
const T0 = 1_000_000;

function tick(symbol: string, provider: FeedProvider, recvMs: number): Tick {
  return { symbol, price: '1', value: 1, ts: recvMs, recvMs, provider };
}

function selector(now = T0): SourceSelector {
  return new SourceSelector(
    OPTS,
    [
      { symbol: 'BTCUSDT', hasFallback: true },
      { symbol: 'BNBUSDT', hasFallback: false },
    ],
    now,
  );
}

/** Primary ticks every `stepMs` over [from, to]; evaluates after each one. */
function runPrimary(s: SourceSelector, from: number, to: number, stepMs = 500): string[] {
  const switches: string[] = [];
  for (let t = from; t <= to; t += stepMs) {
    s.accept(tick('BTCUSDT', 'binance', t));
    for (const sw of s.evaluate(t)) switches.push(`${t}:${sw.to}`);
  }
  return switches;
}

describe('SourceSelector', () => {
  it('uses the primary and drops fallback ticks while the primary is healthy', () => {
    const s = selector();
    expect(s.accept(tick('BTCUSDT', 'binance', T0 + 100))).toBe(true);
    expect(s.accept(tick('BTCUSDT', 'binance_backup', T0 + 150))).toBe(false);
    expect(s.evaluate(T0 + 5000)).toEqual([]);
    expect(s.sourceOf('BTCUSDT')).toBe('binance');
  });

  it('switches to the fallback after 5 s without a primary tick, not before', () => {
    const s = selector();
    s.accept(tick('BTCUSDT', 'binance', T0));
    expect(s.evaluate(T0 + 5000)).toEqual([]);
    const sw = s.evaluate(T0 + 5001);
    expect(sw).toEqual([{ symbol: 'BTCUSDT', from: 'binance', to: 'binance_backup', reason: 'no binance tick for 5001 ms' }]);
    expect(s.sourceOf('BTCUSDT')).toBe('binance_backup');
    expect(s.accept(tick('BTCUSDT', 'binance_backup', T0 + 5100))).toBe(true);
    // Late primary ticks are recorded but not used.
    expect(s.accept(tick('BTCUSDT', 'binance', T0 + 5200))).toBe(false);
  });

  it('fails over at boot when the primary never ticks', () => {
    const s = selector();
    expect(s.evaluate(T0 + 5001).map((x) => x.to)).toEqual(['binance_backup']);
  });

  it('never fails over a symbol without fallback coverage', () => {
    const s = selector();
    s.evaluate(T0 + 60_000);
    expect(s.sourceOf('BNBUSDT')).toBe('binance');
    expect(s.accept(tick('BNBUSDT', 'binance_backup', T0 + 60_001))).toBe(false);
  });

  it('returns to the primary only after 60 s of uninterrupted primary ticks', () => {
    const s = selector();
    s.evaluate(T0 + 5001); // -> fallback
    const start = T0 + 10_000;
    const switches = runPrimary(s, start, start + 61_000);
    expect(switches).toEqual([`${start + 60_000}:binance`]);
    expect(s.sourceOf('BTCUSDT')).toBe('binance');
  });

  it('restarts the 60 s clock when the primary has a gap over 2 s', () => {
    const s = selector();
    s.evaluate(T0 + 5001);
    const a = T0 + 10_000;
    expect(runPrimary(s, a, a + 40_000)).toEqual([]);
    // 2.5 s gap, then steady again: needs a full 60 s from the restart.
    const b = a + 40_000 + 2500;
    const switches = runPrimary(s, b, b + 60_000);
    expect(switches).toEqual([`${b + 60_000}:binance`]);
  });

  it('does not switch back if the primary went quiet right at the 60 s mark', () => {
    const s = selector();
    s.evaluate(T0 + 5001);
    const a = T0 + 10_000;
    runPrimary(s, a, a + 59_000);
    expect(s.evaluate(a + 62_000)).toEqual([]);
    expect(s.sourceOf('BTCUSDT')).toBe('binance_backup');
  });

  it('keeps state for remaining symbols and adds/removes others on setSymbols', () => {
    const s = selector();
    s.evaluate(T0 + 5001);
    s.setSymbols(
      [
        { symbol: 'BTCUSDT', hasFallback: true },
        { symbol: 'ETHUSDT', hasFallback: true },
      ],
      T0 + 6000,
    );
    expect(s.sourceOf('BTCUSDT')).toBe('binance_backup');
    expect(s.sourceOf('ETHUSDT')).toBe('binance');
    expect(s.sourceOf('BNBUSDT')).toBeUndefined();
    expect(s.accept(tick('BNBUSDT', 'binance', T0 + 6001))).toBe(false);
    // ETH failover is measured from when it was added.
    expect(s.evaluate(T0 + 11_000).map((x) => x.symbol)).toEqual([]);
    expect(s.evaluate(T0 + 11_001).map((x) => x.symbol)).toEqual(['ETHUSDT']);
  });
});
