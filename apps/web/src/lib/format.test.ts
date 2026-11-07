import { describe, expect, it } from 'vitest';
import { formatCountdown, formatDuration, formatMoney, formatPrice, formatSignedMoney, parseMoneyToCents, pricePrecision } from './format';

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('money', () => {
  it('formats cents as BRL', () => {
    expect(nbsp(formatMoney(187_000))).toBe('R$ 1.870,00');
    expect(nbsp(formatSignedMoney(870))).toBe('+R$ 8,70');
    expect(nbsp(formatSignedMoney(-1000))).toBe('−R$ 10,00');
    expect(nbsp(formatSignedMoney(0))).toBe('R$ 0,00');
  });

  it.each([
    ['25', 2500],
    ['25,5', 2550],
    ['25,50', 2550],
    ['25.5', 2550],
    ['1.000,00', 100_000],
    ['R$ 10', 1000],
    [' 7 ', 700],
  ])('parses %j', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it.each(['', 'abc', '0', '-5', '1,234', '10,', '1e3'])('rejects %j', (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });
});

describe('prices and time', () => {
  it('picks decimals by magnitude', () => {
    expect(pricePrecision(75_552.63)).toBe(2);
    expect(pricePrecision(90.31)).toBe(2);
    expect(pricePrecision(2.5)).toBe(4);
    expect(pricePrecision(0.42)).toBe(5);
    expect(pricePrecision(0.00001234)).toBe(8);
    expect(formatPrice('75552.63000000')).toBe('75.552,63');
    expect(formatPrice('nope')).toBe('—');
  });

  it('formats countdowns and durations', () => {
    expect(formatCountdown(60_000)).toBe('1:00');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(-10)).toBe('0:00');
    expect(formatDuration(60)).toBe('1min');
    expect(formatDuration(300)).toBe('5min');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(30)).toBe('30s');
  });
});
