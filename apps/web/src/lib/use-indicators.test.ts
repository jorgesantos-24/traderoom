import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { indicatorAccess: async () => [] } }));
const { indicatorAvailable } = await import('./use-indicators');

describe('premium indicator gate', () => {
  it('hides SMC and patterns unless granted; everything else is always available', () => {
    const none = new Set<string>();
    expect(indicatorAvailable('smc', none)).toBe(false);
    expect(indicatorAvailable('patterns', none)).toBe(false);
    expect(indicatorAvailable('rsi', none)).toBe(true);
    expect(indicatorAvailable('supertrend', none)).toBe(true);
    const smcOnly = new Set(['smc']);
    expect(indicatorAvailable('smc', smcOnly)).toBe(true);
    expect(indicatorAvailable('patterns', smcOnly)).toBe(false);
  });
});
