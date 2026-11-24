import { describe, expect, it } from 'vitest';
import {
  analyze,
  brtAt,
  brtDay,
  brtHHMM,
  brtWeekday,
  decideSignal,
  ema,
  nextEntryAt,
  pickSignal,
  reportText,
  rsi,
  signalText,
} from '../src/worker/signal-strategy.js';

const up = Array.from({ length: 60 }, (_, i) => 100 + i + (i % 3 === 0 ? -0.6 : 0));
const down = up.map((v) => 300 - v);

describe('indicators', () => {
  it('ema starts at the first value and follows the series', () => {
    const e = ema([10, 10, 10, 20], 3);
    expect(e[0]).toBe(10);
    expect(e[3]).toBe(15);
  });

  it('rsi is high in an uptrend, low in a downtrend, null without data', () => {
    expect(rsi(up)!).toBeGreaterThan(70);
    expect(rsi(down)!).toBeLessThan(30);
    expect(rsi([1, 2, 3])).toBeNull();
  });
});

describe('analyze / pickSignal', () => {
  it('reads the trend direction', () => {
    expect(analyze(1, up)?.direction).toBe('call');
    expect(analyze(2, down)?.direction).toBe('put');
  });

  it('needs 30 closes and a moving market', () => {
    expect(analyze(1, up.slice(0, 20))).toBeNull();
    expect(analyze(1, Array(40).fill(5))).toBeNull();
  });

  it('prefers confirmed candidates, then strength, and avoids assets already used', () => {
    const a = { assetId: 1, direction: 'call' as const, strength: 5, confirmed: false };
    const b = { assetId: 2, direction: 'put' as const, strength: 1, confirmed: true };
    const c = { assetId: 3, direction: 'put' as const, strength: 2, confirmed: true };
    expect(pickSignal([a, b, null])?.assetId).toBe(2);
    expect(pickSignal([a, b, c])?.assetId).toBe(3);
    expect(pickSignal([a, b, c], new Set([3]))?.assetId).toBe(2);
    expect(pickSignal([a], new Set([1]))?.assetId).toBe(1);
    expect(pickSignal([null])).toBeNull();
  });
});

describe('decideSignal', () => {
  const w = { open: 1, close: 2 };
  const l = { open: 2, close: 1 };
  const t = { open: 1, close: 1 };

  it('wins directly or on a protection', () => {
    expect(decideSignal('call', 2, [w])).toEqual({ result: 'win', step: 0 });
    expect(decideSignal('put', 2, [w, l])).toEqual({ result: 'win', step: 1 });
    expect(decideSignal('call', 2, [l, t, w])).toEqual({ result: 'win', step: 2 });
  });

  it('waits while protections remain', () => {
    expect(decideSignal('call', 2, [])).toBeNull();
    expect(decideSignal('call', 2, [l])).toBeNull();
    expect(decideSignal('call', 2, [l, l])).toBeNull();
  });

  it('loses, draws or voids on the last step', () => {
    expect(decideSignal('call', 2, [l, l, l])).toEqual({ result: 'loss', step: 2 });
    expect(decideSignal('call', 0, [t])).toEqual({ result: 'draw', step: 0 });
    expect(decideSignal('call', 2, [l, null])).toEqual({ result: 'void', step: 1 });
  });
});

describe('schedule and texts', () => {
  it('puts the next entry 2 minutes after the previous result, or the next minute with notice when late', () => {
    const base = brtAt('2030-01-02', 9, 12);
    expect(nextEntryAt(base, base - 2 * 60_000 + 3_000, 2 * 60_000, 60_000)).toBe(base);
    expect(nextEntryAt(base, base - 60_000, 2 * 60_000, 60_000)).toBe(base);
    expect(brtHHMM(nextEntryAt(base, base - 30_000, 2 * 60_000, 60_000))).toBe('09:14');
  });

  it('uses Brasília time', () => {
    const at = brtAt('2030-01-02', 8, 10);
    expect(new Date(at).toISOString()).toBe('2030-01-02T11:10:00.000Z');
    expect(brtHHMM(at)).toBe('08:10');
    expect(brtDay(Date.parse('2030-01-03T02:59:00Z'))).toBe('2030-01-02');
    expect(brtDay(Date.parse('2030-01-03T03:00:00Z'))).toBe('2030-01-03');
    expect(brtWeekday('2026-11-23')).toBe(1);
    expect(brtWeekday('2030-01-02')).toBe(3);
  });

  it('formats a signal with its protections', () => {
    const txt = signalText(
      { display: 'BTC/USDT', direction: 'put', entryAt: brtAt('2030-01-02', 18, 50), expirySec: 300, gales: 2 },
      { signupUrl: 'https://x.test/register' },
    );
    expect(txt).toContain('Entrada às: <b>18:50</b>');
    expect(txt).toContain('5 MINUTOS');
    expect(txt).toContain('VENDA');
    expect(txt).toContain('1ª Proteção às: 18:55');
    expect(txt).toContain('2ª Proteção às: 19:00');
    expect(txt).toContain('href="https://x.test/register"');
  });

  it('reports the real hit rate', () => {
    const e = new Date(brtAt('2030-01-02', 8, 10));
    const txt = reportText(
      'Manhã',
      '2030-01-02',
      [
        { display: 'BTC/USDT', entry_at: e, direction: 'call', result: 'win', result_step: 0 },
        { display: 'ETH/USDT', entry_at: e, direction: 'put', result: 'win', result_step: 1 },
        { display: 'SOL/USDT', entry_at: e, direction: 'put', result: 'loss', result_step: 2 },
        { display: 'XRP/USDT', entry_at: e, direction: 'call', result: 'draw', result_step: 2 },
      ],
      { signupUrl: 'https://x.test' },
    );
    expect(txt).toContain('Wins: <b>2</b>');
    expect(txt).toContain('Loss: <b>1</b>');
    expect(txt).toContain('Total de operações: <b>4</b>');
    expect(txt).toContain('Taxa de acerto: <b>67%</b>');
    expect(txt).toContain('02/01');
    // Lines show only the outcome: no direction, no protection step.
    expect(txt).toContain('08:10 ETH/USDT ✅\n');
    expect(txt).toContain('08:10 SOL/USDT ❌\n');
    expect(txt).not.toMatch(/prot\.|🟢|🔴/);
  });
});
