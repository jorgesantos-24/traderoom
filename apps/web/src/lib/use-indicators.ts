import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PREMIUM_INDICATORS } from '@traderoom/shared';
import { api } from './api';
import { INDICATORS_KEY, loadIndicators, newIndicator, saveIndicators, type IndicatorConfig, type IndicatorMap } from './indicators';

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

/**
 * Indicators per asset, kept in this browser and shared by every component and browser tab.
 * Switching assets shows that asset's own indicators (none until the user adds them there).
 */
let shared: IndicatorMap | null = null;
const listeners = new Set<() => void>();
const NONE: readonly IndicatorConfig[] = [];

function current(): IndicatorMap {
  return (shared ??= loadIndicators());
}

function change(symbol: string, fn: (prev: readonly IndicatorConfig[]) => readonly IndicatorConfig[]) {
  const map = current();
  const prev = map[symbol] ?? NONE;
  const next = fn(prev);
  if (next === prev) return;
  const copy: Record<string, readonly IndicatorConfig[]> = { ...map, [symbol]: next };
  if (next.length === 0) delete copy[symbol];
  shared = copy;
  saveIndicators(copy);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== INDICATORS_KEY && e.key !== null) return;
    shared = loadIndicators();
    listeners.forEach((l) => l());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The indicators on this asset's chart; each type at most once per asset. */
export function useIndicators(symbol: string) {
  const stored = useSyncExternalStore(subscribe, () => current()[symbol] ?? NONE);
  const allowed = usePremiumAccess();
  // A premium indicator without access stays saved (it comes back if access is granted) but is not drawn.
  const list = useMemo(() => stored.filter((c) => indicatorAvailable(c.type, allowed)), [stored, allowed]);

  return {
    list,
    available: (type: string) => indicatorAvailable(type, allowed),
    add: (type: string) => {
      if (!indicatorAvailable(type, allowed)) return;
      change(symbol, (l) => {
        if (l.some((c) => c.type === type)) return l;
        const cfg = newIndicator(type);
        return cfg ? [...l, cfg] : l;
      });
    },
    remove: (id: string) => change(symbol, (l) => l.filter((c) => c.id !== id)),
    update: (cfg: IndicatorConfig) => change(symbol, (l) => l.map((c) => (c.id === cfg.id ? cfg : c))),
    toggle: (id: string) => change(symbol, (l) => l.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))),
  };
}

export type IndicatorsState = ReturnType<typeof useIndicators>;
