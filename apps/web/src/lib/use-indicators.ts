import { useCallback, useEffect, useMemo, useState } from 'react';
import { PREMIUM_INDICATORS } from '@traderoom/shared';
import { api } from './api';
import { loadIndicators, newIndicator, saveIndicators, type IndicatorConfig } from './indicators';

const PREMIUM: ReadonlySet<string> = new Set(PREMIUM_INDICATORS);

/**
 * Premium indicators (SMC, patterns) this user was granted by an admin. Empty until the answer
 * arrives or when it fails, so they stay hidden; asked again when the tab comes back into view.
 */
function usePremiumAccess(): ReadonlySet<string> {
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let stop = false;
    const ask = () =>
      api.indicatorAccess().then(
        (list) => {
          if (stop) return;
          setAllowed((prev) => (prev.size === list.length && list.every((t) => prev.has(t)) ? prev : new Set(list)));
        },
        () => {},
      );
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ask();
    };
    void ask();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return allowed;
}

/** Whether this user may use an indicator type (premium ones need an admin's grant). */
export const indicatorAvailable = (type: string, allowed: ReadonlySet<string>) => !PREMIUM.has(type) || allowed.has(type);

/** Indicators on the chart; the same set on every asset, kept in this browser. */
export function useIndicators() {
  const [stored, setList] = useState<IndicatorConfig[]>(loadIndicators);
  const allowed = usePremiumAccess();
  // A premium indicator without access stays saved (it comes back if access is granted) but is not drawn.
  const list = useMemo(() => stored.filter((c) => indicatorAvailable(c.type, allowed)), [stored, allowed]);

  const change = useCallback((fn: (prev: IndicatorConfig[]) => IndicatorConfig[]) => {
    setList((prev) => {
      const next = fn(prev);
      saveIndicators(next);
      return next;
    });
  }, []);

  return {
    list,
    available: (type: string) => indicatorAvailable(type, allowed),
    add: (type: string) => {
      if (!indicatorAvailable(type, allowed)) return;
      const cfg = newIndicator(type);
      if (cfg) change((l) => [...l, cfg]);
    },
    remove: (id: string) => change((l) => l.filter((c) => c.id !== id)),
    update: (cfg: IndicatorConfig) => change((l) => l.map((c) => (c.id === cfg.id ? cfg : c))),
    toggle: (id: string) => change((l) => l.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))),
  };
}

export type IndicatorsState = ReturnType<typeof useIndicators>;
