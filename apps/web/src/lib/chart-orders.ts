import { parseServerTime } from './clock';
import { netCents } from './orders';
import type { ResultToast } from './use-trade-orders';

/** How long a result bubble stays on the chart (its CSS animation fades it out). */
export const BUBBLE_MS = 3500;

export interface ResultBubble {
  key: string;
  expires: number;
  price: number;
  netCents: number;
}

/** Expiries this close together share one bubble (they would sit on top of each other). */
export const BUBBLE_MERGE_MS = 2000;

/** One bubble per expiry moment on this symbol, with the net result of everything that expired then. */
export function resultBubbles(results: readonly ResultToast[], symbol: string, now = Date.now()): ResultBubble[] {
  const items = results
    .filter((r) => r.order.symbol === symbol && r.order.closePrice !== null && now - r.shownAt <= BUBBLE_MS)
    .map((r) => ({ r, expires: parseServerTime(r.order.expiresAt) }))
    .sort((a, b) => a.expires - b.expires);
  const out: ResultBubble[] = [];
  for (const { r, expires } of items) {
    const last = out.at(-1);
    if (last && expires - last.expires <= BUBBLE_MERGE_MS) {
      last.netCents += netCents(r.order);
      // The bubble sits on the latest expiry of its group.
      last.expires = expires;
      last.price = Number(r.order.closePrice);
    } else {
      out.push({ key: r.key, expires, price: Number(r.order.closePrice), netCents: netCents(r.order) });
    }
  }
  return out;
}
