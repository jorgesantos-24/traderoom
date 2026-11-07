import { describe, expect, it } from 'vitest';
import type { OrderView } from '@traderoom/shared';
import { summarizeSettled } from './use-trade-orders';

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
  closePrice: '101.00000000',
  status: 'won',
  payoutCents: 1870,
  potentialPayoutCents: 1870,
  opensAt: '2026-11-06T15:00:00.000000Z',
  expiresAt: '2026-11-06T15:01:00.000000Z',
  settledAt: '2026-11-06T15:01:01.500000Z',
  ...over,
});

describe('summarizeSettled', () => {
  it('reports a single win with its profit', () => {
    expect(summarizeSettled([order()], 1)).toEqual({ key: 1, outcome: 'won', netCents: 870, count: 1 });
  });

  it('reports a single loss with the stake lost', () => {
    const r = summarizeSettled([order({ status: 'lost', payoutCents: 0 })], 2);
    expect(r).toMatchObject({ outcome: 'lost', netCents: -1000 });
  });

  it('sums orders that settle together', () => {
    const r = summarizeSettled([order(), order({ status: 'lost', payoutCents: 0, stakeCents: 2500 })], 3);
    expect(r).toMatchObject({ outcome: 'lost', netCents: 870 - 2500, count: 2 });
  });

  it('marks all-void batches as void', () => {
    const r = summarizeSettled([order({ status: 'void', payoutCents: 1000 })], 4);
    expect(r).toMatchObject({ outcome: 'void', netCents: 0 });
  });
});
