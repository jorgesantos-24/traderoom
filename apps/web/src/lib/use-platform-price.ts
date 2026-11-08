import { useEffect, useState } from 'react';
import type { PublicOverrideState } from '@traderoom/shared';
import { api } from './api';

/**
 * While the shown price of `symbol` is set by the platform (the feed marks it with `ov`), when it
 * goes back to normal. Asked once per override id; null when the price is natural.
 */
export function usePlatformPrice(symbol: string | null, ov: string | undefined): PublicOverrideState | null {
  const [state, setState] = useState<PublicOverrideState | null>(null);
  useEffect(() => {
    if (!symbol || !ov) {
      setState(null);
      return;
    }
    const ctrl = new AbortController();
    api.marketOverride(symbol, ctrl.signal).then(
      (s) => setState(s.active ? s : null),
      () => {
        // Without the end time the badge still shows (ov alone says the price is set).
        if (!ctrl.signal.aborted) setState({ active: true, untilMs: null, targetPrice: null });
      },
    );
    return () => ctrl.abort();
  }, [symbol, ov]);
  return ov ? (state ?? { active: true, untilMs: null, targetPrice: null }) : null;
}

/** "volta ao normal às 14:03:02" */
export function platformPriceUntil(untilMs: number | null): string {
  if (untilMs === null) return 'volta ao normal ao fim da vela';
  const t = new Date(untilMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `volta ao normal às ${t}`;
}
