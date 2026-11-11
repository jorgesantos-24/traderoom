import type { Mapper } from '../lib/chart-mapper';
import { INDICATOR_BY_TYPE, outputOffset, type IndicatorConfig, type Values } from '../lib/indicators';
import { rgba } from './draw-utils';

const colorOf = (cfg: IndicatorConfig, key: string) =>
  cfg.colors[key] ?? INDICATOR_BY_TYPE.get(cfg.type)?.outputs.find((o) => o.key === key)?.color ?? '#2962ff';

/** Screen x of bar `i`, also past the last candle (the cloud is drawn ahead of the price). */
const barX = (m: Mapper, i: number) => m.xLast + (i - m.lastIdx) * m.spacing;

/** Visible bar range, a few bars wider on each side. */
function visibleBars(m: Mapper): [number, number] {
  return [Math.floor(m.logicalAt(0)) - 2, Math.ceil(m.logicalAt(m.w)) + 2];
}

/**
 * Ichimoku's cloud between Span A and Span B (the lines themselves are chart series): green where
 * A is above B, red where below, like TradingView. Each segment takes the color of its left bar.
 */
export function drawIchimokuCloud(c: CanvasRenderingContext2D, m: Mapper, cfg: IndicatorConfig, v: Record<string, Values>) {
  const a = v.leadA ?? [];
  const b = v.leadB ?? [];
  const def = INDICATOR_BY_TYPE.get('ichimoku')!;
  const off = outputOffset(def, 'leadA', cfg.params);
  const up = rgba(colorOf(cfg, 'leadA'), 0.22);
  const down = rgba(colorOf(cfg, 'leadB'), 0.22);
  const [from, to] = visibleBars(m);
  // Bar i of the values is drawn at bar i + off.
  for (let i = Math.max(0, from - off); i < Math.min(a.length - 1, to - off); i++) {
    const a0 = a[i];
    const a1 = a[i + 1];
    const b0 = b[i];
    const b1 = b[i + 1];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    const ya0 = m.toY(a0);
    const ya1 = m.toY(a1);
    const yb0 = m.toY(b0);
    const yb1 = m.toY(b1);
    if (ya0 === null || ya1 === null || yb0 === null || yb1 === null) continue;
    const x0 = barX(m, i + off);
    const x1 = barX(m, i + 1 + off);
    c.beginPath();
    c.moveTo(x0, ya0);
    c.lineTo(x1, ya1);
    c.lineTo(x1, yb1);
    c.lineTo(x0, yb0);
    c.closePath();
    c.fillStyle = a0 >= b0 ? up : down;
    c.fill();
  }
}

/** Williams Fractals: a triangle over each fractal high (pointing up) and under each fractal low (pointing down). */
export function drawFractals(c: CanvasRenderingContext2D, m: Mapper, cfg: IndicatorConfig, v: Record<string, Values>) {
  const size = Math.max(3, Math.min(6, m.spacing * 0.45));
  const [from, to] = visibleBars(m);
  const draw = (key: 'up' | 'down') => {
    const vals = v[key] ?? [];
    c.fillStyle = colorOf(cfg, key);
    for (let i = Math.max(0, from); i < Math.min(vals.length, to); i++) {
      const p = vals[i];
      if (p == null) continue;
      const y = m.toY(p);
      if (y === null) continue;
      const x = barX(m, i);
      c.beginPath();
      if (key === 'up') {
        const tip = y - 6 - size * 1.6;
        c.moveTo(x, tip);
        c.lineTo(x - size, tip + size * 1.6);
        c.lineTo(x + size, tip + size * 1.6);
      } else {
        const tip = y + 6 + size * 1.6;
        c.moveTo(x, tip);
        c.lineTo(x - size, tip - size * 1.6);
        c.lineTo(x + size, tip - size * 1.6);
      }
      c.closePath();
      c.fill();
    }
  };
  draw('up');
  draw('down');
}
