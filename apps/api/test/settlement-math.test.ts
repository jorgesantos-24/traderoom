import { describe, expect, it } from 'vitest';
import { compareDecimal, creditCents, decideOutcome, profitCents } from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../src/lib/cursor.js';

describe('compareDecimal', () => {
  it.each([
    ['75552.63000000', '75552.63', 0],
    ['75552.63000001', '75552.63', 1],
    ['0.07302000', '0.073021', -1],
    ['100', '99.99999999', 1],
    ['-1', '0', -1],
    ['123456789012.12345679', '123456789012.12345678', 1],
  ] as const)('compare(%s, %s) = %i', (a, b, r) => {
    expect(compareDecimal(a, b)).toBe(r);
  });

  it('rejects non-decimals', () => {
    expect(() => compareDecimal('1e5', '1')).toThrow('not a decimal');
  });
});

describe('decideOutcome', () => {
  const OPEN = '75552.63000000';
  it.each([
    ['call', '75552.63000001', 'won'],
    ['call', '75552.62999999', 'lost'],
    ['put', '75552.62999999', 'won'],
    ['put', '75552.63000001', 'lost'],
    ['call', '75552.63', 'void'],
    ['put', '75552.63000000', 'void'],
  ] as const)('%s with close %s is %s', (direction, close, expected) => {
    expect(decideOutcome(direction, OPEN, close)).toBe(expected);
  });
});

describe('credit on settlement (agreed: stake + profit on a win)', () => {
  it('pays stake + payout% on a win', () => {
    expect(creditCents('won', 10_000, 87)).toBe(18_700);
  });

  it('rounds the profit down to the cent', () => {
    expect(profitCents(1001, 87)).toBe(870); // 870.87
    expect(creditCents('won', 1001, 87)).toBe(1871);
    expect(creditCents('won', 1, 95)).toBe(1);
  });

  it('refunds the stake on a void and pays nothing on a loss', () => {
    expect(creditCents('void', 2500, 87)).toBe(2500);
    expect(creditCents('lost', 2500, 87)).toBe(0);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const c = { at: '2026-11-06T15:00:00.123456Z', id: '42' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(() => decodeCursor('not-base64-json')).toThrow('cursor inválido');
    expect(() => decodeCursor(Buffer.from('["nope","1"]').toString('base64url'))).toThrow('cursor inválido');
  });
});
