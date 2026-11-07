import { describe, expect, it } from 'vitest';
import type { OrderView } from '@traderoom/shared';
import { resultBubbles } from './chart-orders';
import type { ResultToast } from './use-trade-orders';

const EXPIRES = '2026-11-06T15:01:00.000000Z';
const T_EXP = Date.parse('2026-11-06T15:01:00Z');

const order = (over: Partial<OrderView> = {}): OrderView => ({
  account: 'real',
  id: 'a',
  assetId: 1,
  symbol: 'ETHUSDT',
  direction: 'call',
  stakeCents: 2000,
  payoutPct: 93,
  durationSec: 60,
  openPrice: '2000.00000000',
  closePrice: '2001.00000000',
  status: 'won',
  payoutCents: 3860,
  potentialPayoutCents: 3860,
  opensAt: '2026-11-06T15:00:00.000000Z',
  expiresAt: EXPIRES,
  settledAt: '2026-11-06T15:01:01.000000Z',
  ...over,
});

describe('resultBubbles', () => {
  const toast = (o: OrderView, shownAt = 1000): ResultToast => ({ key: o.id, order: o, display: 'ETH/USD', shownAt });

  it('sums orders that expired together on this symbol', () => {
    const won = order({ id: 'w' });
    const lost = order({ id: 'l', direction: 'put', status: 'lost', payoutCents: 0 });
    const other = order({ id: 'o', symbol: 'BTCUSDT' });
    expect(resultBubbles([toast(won), toast(lost), toast(other)], 'ETHUSDT', 2000)).toEqual([
      { key: 'w', expires: T_EXP, price: 2001, netCents: 1860 - 2000 },
    ]);
  });

  it('merges expiries up to 2 s apart into one bubble and keeps distant ones apart', () => {
    const a = order({ id: 'a' });
    const b = order({ id: 'b', status: 'lost', payoutCents: 0, expiresAt: '2026-11-06T15:01:01.500000Z', closePrice: '2002.00000000' });
    const c = order({ id: 'c', expiresAt: '2026-11-06T15:01:10.000000Z' });
    expect(resultBubbles([toast(c), toast(b), toast(a)], 'ETHUSDT', 2000)).toEqual([
      { key: 'a', expires: T_EXP + 1500, price: 2002, netCents: 1860 - 2000 },
      { key: 'c', expires: T_EXP + 10_000, price: 2001, netCents: 1860 },
    ]);
  });

  it('drops bubbles once their time is up', () => {
    expect(resultBubbles([toast(order(), 1000)], 'ETHUSDT', 1000 + 3501)).toEqual([]);
  });
});
