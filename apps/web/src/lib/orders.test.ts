import { describe, expect, it } from 'vitest';
import type { OrderView } from '@traderoom/shared';
import { liveResult, msLeft, netCents, progress, settleCheckAt, upsertOrders } from './orders';

const order = (over: Partial<OrderView> = {}): OrderView => ({
  account: 'real',
  id: '00000000-0000-4000-8000-000000000001',
  assetId: 1,
  symbol: 'BTCUSDT',
  direction: 'call',
  stakeCents: 1000,
  payoutPct: 87,
  durationSec: 60,
  openPrice: '100.00000000',
  closePrice: null,
  status: 'open',
  payoutCents: 0,
  potentialPayoutCents: 1870,
  opensAt: '2026-11-06T15:00:00.000000Z',
  expiresAt: '2026-11-06T15:01:00.000000Z',
  settledAt: null,
  overrideId: null,
  ...over,
});

const T0 = Date.UTC(2026, 10, 6, 15);

describe('liveResult', () => {
  it('follows the settlement rule', () => {
    expect(liveResult('call', '100.00000000', 100.5)).toBe('winning');
    expect(liveResult('call', '100.00000000', 99.99)).toBe('losing');
    expect(liveResult('put', '100.00000000', 99.99)).toBe('winning');
    expect(liveResult('put', '100.00000000', 100.00000001)).toBe('losing');
    expect(liveResult('call', '100.00000000', 100)).toBe('tie');
    expect(liveResult('call', '100.00000000', null)).toBe('unknown');
    expect(liveResult('call', '0.00001000', 0.00001)).toBe('tie');
  });
});

describe('timing', () => {
  it('computes time left, progress and when to poll', () => {
    const o = order();
    expect(msLeft(o, T0 + 15_000)).toBe(45_000);
    expect(msLeft(o, T0 + 61_000)).toBe(0);
    expect(progress(o, T0 + 30_000)).toBe(0.5);
    expect(progress(o, T0 - 1)).toBe(0);
    expect(progress(o, T0 + 90_000)).toBe(1);
    expect(settleCheckAt(o)).toBe(T0 + 60_000 + 200);
  });
});

describe('netCents and upsertOrders', () => {
  it('nets payout against stake', () => {
    expect(netCents(order({ status: 'won', payoutCents: 1870 }))).toBe(870);
    expect(netCents(order({ status: 'lost', payoutCents: 0 }))).toBe(-1000);
    expect(netCents(order({ status: 'void', payoutCents: 1000 }))).toBe(0);
    expect(netCents(order())).toBe(0);
  });

  it('replaces by id and sorts newest first', () => {
    const a = order({ id: 'a', opensAt: '2026-11-06T15:00:00.000000Z' });
    const b = order({ id: 'b', opensAt: '2026-11-06T15:00:05.000000Z' });
    const a2 = { ...a, status: 'won' as const };
    expect(upsertOrders([a], [b]).map((o) => o.id)).toEqual(['b', 'a']);
    expect(upsertOrders([a, b], [a2]).find((o) => o.id === 'a')?.status).toBe('won');
    expect(upsertOrders([a, b], [a2])).toHaveLength(2);
  });
});
