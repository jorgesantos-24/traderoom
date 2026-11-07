import { useCallback, useState } from 'react';
import { loadIndicators, newIndicator, saveIndicators, type IndicatorConfig } from './indicators';

/** Indicators on the chart; the same set on every asset, kept in this browser. */
export function useIndicators() {
  const [list, setList] = useState<IndicatorConfig[]>(loadIndicators);

  const change = useCallback((fn: (prev: IndicatorConfig[]) => IndicatorConfig[]) => {
    setList((prev) => {
      const next = fn(prev);
      saveIndicators(next);
      return next;
    });
  }, []);

  return {
    list,
    add: (type: string) => {
      const cfg = newIndicator(type);
      if (cfg) change((l) => [...l, cfg]);
    },
    remove: (id: string) => change((l) => l.filter((c) => c.id !== id)),
    update: (cfg: IndicatorConfig) => change((l) => l.map((c) => (c.id === cfg.id ? cfg : c))),
    toggle: (id: string) => change((l) => l.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))),
  };
}

export type IndicatorsState = ReturnType<typeof useIndicators>;
