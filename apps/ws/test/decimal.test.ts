import { describe, expect, it } from 'vitest';
import { midPrice } from '../src/feed/decimal.js';

describe('midPrice', () => {
  it.each([
    ['75552.62000000', '75552.64000000', '75552.63000000'],
    // Half a satoshi rounds up.
    ['100.00000001', '100.00000002', '100.00000002'],
    ['0.07302000', '0.07302100', '0.07302050'],
    ['0.18810000', '0.18810000', '0.18810000'],
    // Inputs with fewer or more decimals.
    ['1', '2', '1.50000000'],
    ['3000.5', '3000.51', '3000.50500000'],
    ['0.000000001', '0.000000002', '0.00000000'],
    ['0.000000004', '0.000000006', '0.00000001'],
    // Values far beyond float precision stay exact.
    ['123456789012.12345678', '123456789012.12345680', '123456789012.12345679'],
  ])('mid(%s, %s) = %s', (bid, ask, expected) => {
    expect(midPrice(bid, ask)).toBe(expected);
  });

  it('rejects non-decimal input', () => {
    expect(() => midPrice('1e5', '2')).toThrow('not a decimal');
  });
});
