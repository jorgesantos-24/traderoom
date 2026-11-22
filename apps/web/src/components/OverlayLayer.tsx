import { useEffect, useRef, type RefObject } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle } from '@traderoom/shared';
import { loadCandles } from '../lib/candle-cache';
import { createMapper, type Mapper } from '../lib/chart-mapper';
import { formatPrice, pricePrecision } from '../lib/format';
import { INDICATOR_BY_TYPE, type IndicatorConfig, type Values } from '../lib/indicators';
import { findPatterns, patternSettings, type Pattern } from '../lib/patterns';
import { computeSmc, previousLevels, smcSettings, visibleSmc, type SmcResult } from '../lib/smc';
import { drawFractals, drawIchimokuCloud } from './draw-extras';
import { drawPatterns } from './draw-patterns';
import { FONT, rgba } from './draw-utils';

interface Props {
  hostRef: RefObject<HTMLDivElement | null>;
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>;
  candlesRef: RefObject<Candle[] | null>;
  stepRef: RefObject<number>;
  configs: readonly IndicatorConfig[];
  symbol: string;
}

const NEUTRAL = '#b2b5be';
const DAILY_REFRESH_MS = 10 * 60_000;
/** On-chart names for the structure breaks: CT (continuação de tendência, BOS) and MT (mudança de tendência, CHoCH). */
const STRUCTURE_LABEL = { BOS: 'CT', CHoCH: 'MT' } as const;

/** Indicators drawn by this layer, in drawing order (the Ichimoku cloud at the bottom, SMC labels on top). */
const OVERLAY_TYPES = ['ichimoku', 'patterns', 'fractals', 'smc'];

/** Canvas over the candles for the overlay indicators (Smart Money Concepts, chart patterns). */
export function OverlayLayer({ hostRef, chartRef, seriesRef, candlesRef, stepRef, configs, symbol }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configsRef = useRef(configs);
  configsRef.current = configs;
  const dailyRef = useRef<Candle[] | null>(null);
  const active = configs.filter((c) => c.type === 'smc' && c.visible);
  const needDaily = active.some((c) => (c.params.prevDay ?? 0) >= 0.5 || (c.params.prevWeek ?? 0) >= 0.5);

  // Daily candles for the previous day / week levels.
  useEffect(() => {
    dailyRef.current = null;
    if (!needDaily) return;
    let stop = false;
    const get = () =>
      loadCandles(symbol, '1d', 15).then(
        (d) => {
          if (!stop) dailyRef.current = d;
        },
        () => {},
      );
    void get();
    const id = setInterval(get, DAILY_REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [symbol, needDaily]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(host.clientWidth * dpr);
      canvas.height = Math.round(host.clientHeight * dpr);
      canvas.style.width = `${host.clientWidth}px`;
      canvas.style.height = `${host.clientHeight}px`;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Detection runs on closed candles only, and only when one closes or a setting changes.
    type Result = SmcResult | Pattern[] | Record<string, Values>;
    const cache = new Map<string, { key: string; result: Result }>();
    const arrays = new WeakMap<Candle[], number>();
    let arrayId = 0;
    const resultFor = (cfg: IndicatorConfig, candles: Candle[]): Result => {
      if (!arrays.has(candles)) arrays.set(candles, ++arrayId);
      const closed = candles.length - 1;
      // The cloud follows the live candle (as its lines do), so it also changes with the last high/low.
      const live = cfg.type === 'ichimoku' ? `|${candles[closed]?.h}|${candles[closed]?.l}` : '';
      const key = `${arrays.get(candles)}|${closed}|${candles[0]?.t}|${JSON.stringify(cfg.params)}${live}`;
      const hit = cache.get(cfg.id);
      if (hit && hit.key === key) return hit.result;
      const closedCandles = candles.slice(0, closed);
      const result =
        cfg.type === 'smc'
          ? computeSmc(closedCandles, smcSettings(cfg.params).options)
          : cfg.type === 'patterns'
            ? findPatterns(closedCandles, patternSettings(cfg.params).options)
            : INDICATOR_BY_TYPE.get(cfg.type)!.compute(cfg.type === 'ichimoku' ? candles : closedCandles, cfg.params);
      cache.set(cfg.id, { key, result });
      return result;
    };

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      const list = configsRef.current
        .filter((c) => c.visible && OVERLAY_TYPES.includes(c.type))
        .sort((a, b) => OVERLAY_TYPES.indexOf(a.type) - OVERLAY_TYPES.indexOf(b.type));
      if (list.length === 0) return;
      const m = createMapper(chartRef.current, seriesRef.current, candlesRef.current, stepRef.current);
      if (!m) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, m.w, m.h);
      ctx.clip();
      for (const cfg of list) {
        const r = resultFor(cfg, m.candles);
        if (cfg.type === 'smc') drawSmc(ctx, m, cfg, r as SmcResult, dailyRef.current);
        else if (cfg.type === 'patterns') drawPatterns(ctx, m, cfg, r as Pattern[]);
        else if (cfg.type === 'ichimoku') drawIchimokuCloud(ctx, m, cfg, r as Record<string, Values>);
        else drawFractals(ctx, m, cfg, r as Record<string, Values>);
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [hostRef, chartRef, seriesRef, candlesRef, stepRef]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-[4]" data-testid="overlay-layer" />;
}

function drawSmc(c: CanvasRenderingContext2D, m: Mapper, cfg: IndicatorConfig, r: SmcResult, daily: Candle[] | null) {
  const def = INDICATOR_BY_TYPE.get('smc')!;
  const color = (key: string) => cfg.colors[key] ?? def.outputs.find((o) => o.key === key)?.color ?? NEUTRAL;
  const bull = color('bull');
  const bear = color('bear');
  const s = smcSettings(cfg.params);
  const v = visibleSmc(r, s.view);
  const X = (idx: number) => m.toX(m.candles[idx]!.t);
  const right = m.w;
  const last = m.candles[m.lastIdx]!;
  const precision = pricePrecision(last.c);

  const text = (
    t: string,
    x: number,
    y: number,
    fill: string,
    opts: { size?: number; weight?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline } = {},
  ) => {
    c.font = `${opts.weight ?? 600} ${opts.size ?? 10}px ${FONT}`;
    c.textAlign = opts.align ?? 'center';
    c.textBaseline = opts.base ?? 'middle';
    c.fillStyle = fill;
    c.fillText(t, x, y);
  };
  const hline = (x1: number, x2: number, y: number, stroke: string, width: number, dash: number[]) => {
    c.beginPath();
    c.setLineDash(dash);
    c.lineWidth = width;
    c.strokeStyle = stroke;
    c.moveTo(x1, Math.round(y) + 0.5);
    c.lineTo(x2, Math.round(y) + 0.5);
    c.stroke();
    c.setLineDash([]);
  };
  const box = (x1: number, x2: number, top: number, bottom: number, fill: string, stroke: string | null) => {
    const y1 = m.toY(top);
    const y2 = m.toY(bottom);
    if (y1 === null || y2 === null || x2 < 0 || x1 > right) return null;
    const h = Math.max(1, y2 - y1);
    c.fillStyle = fill;
    c.fillRect(x1, y1, x2 - x1, h);
    if (stroke) {
      c.lineWidth = 1;
      c.strokeStyle = stroke;
      c.strokeRect(Math.round(x1) + 0.5, Math.round(y1) + 0.5, Math.round(x2 - x1), Math.round(h));
    }
    return { y1, y2 };
  };

  // Premium / equilibrium / discount of the current swing range.
  if (s.zones && r.range && r.range.top > r.range.bottom) {
    const { top, bottom } = r.range;
    const span = top - bottom;
    const x1 = X(Math.min(r.range.topIdx, r.range.bottomIdx));
    const mid = (top + bottom) / 2;
    const p = box(x1, right, top, top - span * 0.1, rgba(bear, 0.1), null);
    if (p) text('Premium', right - 6, (p.y1 + p.y2) / 2, rgba(bear, 0.85), { align: 'right' });
    const e = box(x1, right, mid + span * 0.02, mid - span * 0.02, rgba(NEUTRAL, 0.08), null);
    const ym = m.toY(mid);
    if (ym !== null) hline(x1, right, ym, rgba(NEUTRAL, 0.45), 1, [2, 3]);
    if (e) text('Equilíbrio', right - 6, (e.y1 + e.y2) / 2, rgba(NEUTRAL, 0.8), { align: 'right' });
    const d = box(x1, right, bottom + span * 0.1, bottom, rgba(bull, 0.1), null);
    if (d) text('Desconto', right - 6, (d.y1 + d.y2) / 2, rgba(bull, 0.85), { align: 'right' });
  }

  // Order blocks: still-valid ones reach the right edge.
  for (const ob of v.orderBlocks) {
    const col = ob.dir === 1 ? color('obBull') : color('obBear');
    const swing = ob.level === 'swing';
    const b = box(X(ob.from), right, ob.top, ob.bottom, rgba(col, swing ? 0.2 : 0.12), rgba(col, swing ? 0.6 : 0.35));
    if (b && b.y2 - b.y1 >= 9) {
      text(swing ? 'OB' : 'iOB', X(ob.from) + 4, (b.y1 + b.y2) / 2, rgba(col, 0.9), { align: 'left', size: 9, weight: 700 });
    }
  }

  // Fair value gaps: the unfilled part, with its midpoint (consequent encroachment).
  for (const g of v.fvgs) {
    const col = g.dir === 1 ? color('fvgBull') : color('fvgBear');
    // Short boxes (a few bars), like on TradingView; a full-width box per open gap buries the chart.
    const x2 = Math.min(right, X(g.from) + s.fvgExtend * m.spacing);
    const b = box(X(g.from), x2, g.top, g.bottom, rgba(col, 0.16), rgba(col, 0.3));
    if (!b) continue;
    const ym = m.toY((g.gapTop + g.gapBottom) / 2);
    if (ym !== null && ym > b.y1 && ym < b.y2) hline(X(g.from), x2, ym, rgba(col, 0.45), 1, [3, 3]);
    if (b.y2 - b.y1 >= 9) text('FVG', X(g.from) + 4, (b.y1 + b.y2) / 2, rgba(col, 0.9), { align: 'left', size: 9, weight: 700 });
  }

  // Previous day / week levels.
  if (daily && (s.prevDay || s.prevWeek)) {
    const lv = previousLevels(daily, last.t);
    const col = color('levels');
    // Levels outside the visible prices still show, as a tag pinned to the top or bottom edge.
    const edge = { above: 0, below: 0 };
    const draw = (price: number, start: number, label: string) => {
      const y = m.toY(price);
      if (y === null) return;
      const name = `${label} ${formatPrice(price, precision)}`;
      if (y < 0 || y > m.h) {
        const up = y < 0;
        const n = up ? edge.above++ : edge.below++;
        text(`${up ? '▲' : '▼'} ${name}`, right - 6, up ? 10 + n * 13 : m.h - 10 - n * 13, rgba(col, 0.85), { align: 'right', size: 9 });
        return;
      }
      const x1 = Math.max(0, m.toX(start));
      hline(x1, right, y, rgba(col, 0.7), 1, [6, 4]);
      text(name, right - 6, y - 7, rgba(col, 0.95), { align: 'right', size: 9 });
    };
    if (s.prevDay && lv.day) {
      draw(lv.day.high, lv.day.start, 'PDH');
      draw(lv.day.low, lv.day.start, 'PDL');
    }
    if (s.prevWeek && lv.week) {
      draw(lv.week.high, lv.week.start, 'PWH');
      draw(lv.week.low, lv.week.start, 'PWL');
    }
  }

  // Equal highs / lows: resting liquidity; faded once a wick took it.
  for (const e of v.equal) {
    const ya = m.toY(e.a.price);
    const yb = m.toY(e.b.price);
    if (ya === null || yb === null) continue;
    const col = color('equal');
    const alpha = e.swept === null ? 0.95 : 0.4;
    const xa = X(e.a.idx);
    const xb = X(e.b.idx);
    c.beginPath();
    c.setLineDash([1, 3]);
    c.lineWidth = 1.5;
    c.strokeStyle = rgba(col, alpha);
    c.moveTo(xa, ya);
    c.lineTo(xb, yb);
    c.stroke();
    c.setLineDash([]);
    const up = e.kind === 'EQH';
    text(e.kind, (xa + xb) / 2, (ya + yb) / 2 + (up ? -8 : 8), rgba(col, alpha), { size: 9, weight: 700 });
  }

  // Market structure: the broken level from the swing to the breaking close.
  for (const ev of v.structure) {
    const y = m.toY(ev.price);
    if (y === null) continue;
    const col = ev.dir === 1 ? bull : bear;
    const swing = ev.level === 'swing';
    const x1 = X(ev.from);
    const x2 = X(ev.to);
    hline(x1, x2, y, col, swing ? 1.5 : 1, swing ? [] : [4, 3]);
    text(STRUCTURE_LABEL[ev.kind], (x1 + x2) / 2, y + (ev.dir === 1 ? -7 : 8), col, { size: swing ? 11 : 9, weight: swing ? 700 : 600 });
  }

  // Swing points.
  for (const p of v.swings) {
    const y = m.toY(p.price);
    if (y === null) continue;
    const col = p.label === 'HH' || p.label === 'HL' ? bull : bear;
    text(p.label, X(p.idx), y + (p.dir === 1 ? -9 : 10), col, { size: 10, weight: 700 });
  }

  // Strong / weak extremes: the one protecting the swing trend is strong.
  if (s.strongWeak && r.range) {
    const trend = r.trend.swing;
    const yt = m.toY(r.range.top);
    if (yt !== null) {
      hline(X(r.range.topIdx), right, yt, rgba(bear, 0.8), 1, []);
      text(trend === -1 ? 'Topo forte' : trend === 1 ? 'Topo fraco' : 'Topo', right - 6, yt - 7, bear, { align: 'right', size: 10 });
    }
    const yb = m.toY(r.range.bottom);
    if (yb !== null) {
      hline(X(r.range.bottomIdx), right, yb, rgba(bull, 0.8), 1, []);
      text(trend === 1 ? 'Fundo forte' : trend === -1 ? 'Fundo fraco' : 'Fundo', right - 6, yb + 8, bull, { align: 'right', size: 10 });
    }
  }
}
