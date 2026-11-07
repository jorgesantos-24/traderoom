import { describe, expect, it } from 'vitest';
import { Registry } from '../src/lib/metrics.js';

describe('Registry', () => {
  it('renders counters and gauges in Prometheus text format', () => {
    const r = new Registry();
    const c = r.counter('feed_ticks_received_total', 'Trades received.');
    c.inc({ provider: 'binance' });
    c.inc({ provider: 'binance' }, 2);
    c.inc({ provider: 'binance_backup' });
    const g = r.gauge('ws_connections', 'Open sockets.');
    g.set({}, 42);
    r.gauge('feed_lag_ms', 'Lag.', () => [[{ symbol: 'BTCUSDT' }, 120]]);

    expect(r.render()).toBe(
      [
        '# HELP feed_ticks_received_total Trades received.',
        '# TYPE feed_ticks_received_total counter',
        'feed_ticks_received_total{provider="binance"} 3',
        'feed_ticks_received_total{provider="binance_backup"} 1',
        '# HELP ws_connections Open sockets.',
        '# TYPE ws_connections gauge',
        'ws_connections 42',
        '# HELP feed_lag_ms Lag.',
        '# TYPE feed_lag_ms gauge',
        'feed_lag_ms{symbol="BTCUSDT"} 120',
        '',
      ].join('\n'),
    );
    expect(c.get({ provider: 'binance' })).toBe(3);
  });

  it('sorts and escapes labels', () => {
    const r = new Registry();
    r.counter('x_total', 'X.').inc({ b: 'say "hi"\n', a: 'back\\slash' });
    expect(r.render()).toContain('x_total{a="back\\\\slash",b="say \\"hi\\"\\n"} 1');
  });

  it('renders special float values', () => {
    const r = new Registry();
    r.gauge('g', 'G.', () => [
      [{ k: 'nan' }, NaN],
      [{ k: 'inf' }, Infinity],
    ]);
    expect(r.render()).toContain('g{k="nan"} NaN\ng{k="inf"} +Inf');
  });
});
