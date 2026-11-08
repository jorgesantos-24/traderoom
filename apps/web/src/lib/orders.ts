import { compareDecimal, profitCents, type Direction, type OrderView } from '@traderoom/shared';
import { parseServerTime } from './clock';

export type LiveResult = 'winning' | 'losing' | 'tie' | 'unknown';

/** Mirrors the settlement rule: call wins above the open price, put below, equal is a tie (void). */
export function liveResult(direction: Direction, openPrice: string, price: number | null): LiveResult {
  if (price === null || !Number.isFinite(price) || price <= 0) return 'unknown';
  const cmp = compareDecimal(price.toFixed(8), openPrice);
  if (cmp === 0) return 'tie';
  return cmp > 0 === (direction === 'call') ? 'winning' : 'losing';
}

/** Server-side worker waits this long after expiry before settling (SETTLE_GRACE_MS in the API). */
export const SETTLE_GRACE_MS = 1500;

/** When to start asking the API whether an order has been settled. */
export function settleCheckAt(order: Pick<OrderView, 'expiresAt'>): number {
  return parseServerTime(order.expiresAt) + SETTLE_GRACE_MS + 500;
}

export function msLeft(order: Pick<OrderView, 'expiresAt'>, serverNow: number): number {
  return Math.max(0, parseServerTime(order.expiresAt) - serverNow);
}

/** Fraction of the order's lifetime already elapsed, 0..1, for the progress bar. */
export function progress(order: Pick<OrderView, 'opensAt' | 'expiresAt'>, serverNow: number): number {
  const start = parseServerTime(order.opensAt);
  const end = parseServerTime(order.expiresAt);
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (serverNow - start) / (end - start)));
}

export function expectedProfitCents(stakeCents: number, payoutPct: number): number {
  return profitCents(stakeCents, payoutPct);
}

/** Net result of a settled order, in cents (payout minus stake). */
export function netCents(order: Pick<OrderView, 'status' | 'payoutCents' | 'stakeCents'>): number {
  return order.status === 'open' ? 0 : order.payoutCents - order.stakeCents;
}

/**
 * Replaces items by id and keeps the list sorted newest first. Used to fold
 * fresh pages from the API into what is on screen without duplicates.
 */
export function upsertOrders(current: readonly OrderView[], incoming: readonly OrderView[]): OrderView[] {
  const byId = new Map(current.map((o) => [o.id, o]));
  for (const o of incoming) byId.set(o.id, o);
  return [...byId.values()].sort((a, b) => (a.opensAt < b.opensAt ? 1 : a.opensAt > b.opensAt ? -1 : a.id < b.id ? 1 : -1));
}
