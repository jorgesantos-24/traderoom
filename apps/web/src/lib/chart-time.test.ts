import { describe, expect, it } from 'vitest';
import { crosshairLabel, tickLabel } from './chart-time';

const M5 = 5 * 60_000;
const D1 = 86_400_000;
const sec = (iso: string) => Date.parse(iso) / 1000;

describe('chart time labels (Brasília, UTC-3)', () => {
  it('shows intraday ticks in Brasília time, whatever the computer zone', () => {
    expect(tickLabel(sec('2026-11-07T16:05:00Z'), M5)).toBe('13:05');
    // UTC midnight is 21:00 in Brasília: a time, not a date.
    expect(tickLabel(sec('2026-11-07T00:00:00Z'), M5)).toBe('21:00');
  });

  it('shows the date on Brasília midnight', () => {
    expect(tickLabel(sec('2026-11-07T03:00:00Z'), M5)).toBe('07/11');
  });

  it('names daily candles by their UTC date, as TradingView does', () => {
    expect(tickLabel(sec('2026-11-07T00:00:00Z'), D1)).toBe('07/11');
    expect(crosshairLabel(sec('2026-11-07T00:00:00Z'), D1)).toBe('07/11/2026');
  });

  it('crosshair shows date and Brasília time intraday', () => {
    expect(crosshairLabel(sec('2026-11-07T16:05:00Z'), M5)).toMatch(/^07\/11,? 13:05$/);
  });
});
