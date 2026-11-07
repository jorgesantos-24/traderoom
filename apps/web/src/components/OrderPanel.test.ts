import { describe, expect, it } from 'vitest';
import { blockReason, nextStakeCents, STAKE_PRESETS_CENTS, stepDuration } from './OrderPanel';

const limits = { minStakeCents: 100, maxStakeCents: 1_000_000, durationsSec: [60, 300] };
const fresh = { price: 100, ts: 1, stale: false };
const ok = { feedStatus: 'open' as const, quote: fresh, balanceCents: 5000, stakeCents: 1000, limits };

describe('blockReason', () => {
  it('allows a valid order', () => {
    expect(blockReason(ok)).toBeNull();
    expect(STAKE_PRESETS_CENTS).toEqual([1000, 2500, 5000, 10000]);
  });

  it('blocks while the feed is down or the asset is stale', () => {
    expect(blockReason({ ...ok, feedStatus: 'reconnecting' })).toMatch(/conexão/i);
    expect(blockReason({ ...ok, quote: null })).toMatch(/aguardando/i);
    expect(blockReason({ ...ok, quote: { ...fresh, stale: true } })).toMatch(/defasada/i);
    expect(blockReason({ ...ok, quote: { price: null, ts: 0, stale: true } })).toMatch(/defasada/i);
  });

  it('blocks on invalid stake and insufficient balance', () => {
    expect(blockReason({ ...ok, stakeCents: null })).toMatch(/valor válido/);
    expect(blockReason({ ...ok, stakeCents: 50 })).toMatch(/mínimo/);
    expect(blockReason({ ...ok, stakeCents: 2_000_000 })).toMatch(/máximo/);
    expect(blockReason({ ...ok, balanceCents: null })).toMatch(/saldo/i);
    expect(blockReason({ ...ok, balanceCents: 999 })).toBe('Saldo insuficiente para este valor.');
    expect(blockReason({ ...ok, balanceCents: 1000 })).toBeNull();
  });
});

describe('nextStakeCents', () => {
  const limits = { minStakeCents: 100, maxStakeCents: 100000 };
  it('doubles on + and halves on −', () => {
    expect(nextStakeCents(1000, 1, limits)).toBe(2000);
    expect(nextStakeCents(1000, -1, limits)).toBe(500);
    expect(nextStakeCents(2500, -1, limits)).toBe(1250);
  });
  it('rounds halves down to the cent', () => {
    expect(nextStakeCents(1001, -1, limits)).toBe(500);
  });
  it('stays inside the limits', () => {
    expect(nextStakeCents(80000, 1, limits)).toBe(100000);
    expect(nextStakeCents(150, -1, limits)).toBe(100);
  });
});

describe('stepDuration', () => {
  const opts = [30, 60, 300, 600, 900, 1800];
  it('walks the list with + and −', () => {
    expect(stepDuration(opts, 60, 1)).toBe(300);
    expect(stepDuration(opts, 60, -1)).toBe(30);
  });
  it('stops at the ends', () => {
    expect(stepDuration(opts, 1800, 1)).toBe(1800);
    expect(stepDuration(opts, 30, -1)).toBe(30);
  });
  it('falls back to the first option when the current one is gone', () => {
    expect(stepDuration(opts, 120, 1)).toBe(30);
  });
});
