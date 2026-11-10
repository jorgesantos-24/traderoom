import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type UTCTimestamp,
} from 'lightweight-charts';
import { candleExpiry, LATE_ENTRY_MS, type Candle, type CandleInterval, type OrderView } from '@traderoom/shared';
import { ApiError } from '../lib/api';
import { cachedCandles, loadCandles } from '../lib/candle-cache';
import { MOTION_TAU_MS, seedCandle, stepCandle } from '../lib/candle-motion';
import { intervalMs, mergePrice } from '../lib/candles';
import { crosshairLabel, tickLabel } from '../lib/chart-time';
import { resultBubbles } from '../lib/chart-orders';
import { serverClock, parseServerTime } from '../lib/clock';
import { formatCountdown, formatMoney, formatPrice, formatSignedMoney, pricePrecision } from '../lib/format';
import { useQuote } from '../lib/session-data';
import type { ResultToast } from '../lib/use-trade-orders';
import { useDrawings } from '../lib/use-drawings';
import { IndicatorRenderer } from '../lib/indicator-series';
import type { IndicatorConfig } from '../lib/indicators';
import { useIndicators } from '../lib/use-indicators';
import { IndicatorLegend, IndicatorSettings, IndicatorsButton, IndicatorsDialog } from './Indicators';
import { DrawingLayer } from './DrawingLayer';
import { OverlayLayer } from './OverlayLayer';
import { DrawingToolbar } from './DrawingToolbar';
import { cx, ErrorState, LoadingState } from './ui';

const COLORS = {
  grid: 'rgba(255,255,255,0.1)',
  border: '#242d3c',
  text: '#c4c6c9',
  up: '#00b535',
  down: '#d74a37',
  warn: '#f5a524',
  brand: '#00d8e8',
};

export type ChartType = 'line' | 'candles';
const CHART_TYPE_KEY = 'traderoom.chartType';
/** Each chart opens showing this much history (minutes), as on the Kyden platform. */
const SPAN_MIN = 180;

function readStored<T extends string | number>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = (typeof fallback === 'number' ? Number(raw) : raw) as T;
    return raw !== null && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode: kept for this visit only.
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** "00:25": minutes and seconds left, as the Kyden purchase timer shows them. */
export function purchaseCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
export const CANDLE_LIMIT = 500;

/** Entry line colour: yellow while a late entry waits for its candle, then green (buy) or red (sell). */
function lineColor(o: OrderView, waiting: boolean): string {
  if (waiting) return COLORS.warn;
  return o.direction === 'call' ? COLORS.up : COLORS.down;
}

/** Order tags on the chart use the trading terms traders know. */
const TAG_LABEL = { call: 'Buy', put: 'Sell' } as const;

const toPoint = (c: Candle) => ({ time: (c.t / 1000) as UTCTimestamp, value: c.c });

const toBar = (c: Candle) => ({
  time: (c.t / 1000) as UTCTimestamp,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
});

interface Props {
  symbol: string;
  display: string;
  interval: CandleInterval;
  /** Open orders on this symbol: entry price line plus a tag with the countdown. */
  orders: readonly OrderView[];
  /** Recently settled orders (any symbol); this symbol's get a result bubble at their expiry. */
  results: readonly ResultToast[];
  /** Shown in the bottom-left tool column (the timeframe picker). */
  toolbarTop?: ReactNode;
  /** Expiry picked in the order panel: draws the purchase deadline and the expiry line. */
  durationSec?: number;
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export function PriceChart({ symbol, display, interval, orders, results, toolbarTop, durationSec = 60 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawings = useDrawings(symbol);
  const indicators = useIndicators();
  const rendererRef = useRef<IndicatorRenderer | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingIndicator, setEditingIndicator] = useState<IndicatorConfig | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const tagPriceRef = useRef<HTMLSpanElement>(null);
  const tagTimeRef = useRef<HTMLSpanElement>(null);
  const orderTagsRef = useRef<HTMLDivElement>(null);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const ordersRef = useRef(orders);
  const linesRef = useRef(new Map<string, IPriceLine>());
  ordersRef.current = orders;
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** Line view (default, as on the Kyden platform): close prices with a soft grey fill. */
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [chartType, setChartType] = useState<ChartType>(() => readStored(CHART_TYPE_KEY, ['line', 'candles'] as const, 'line'));
  const [drawOpen, setDrawOpen] = useState(false);
  const durationRef = useRef(durationSec);
  durationRef.current = durationSec;
  const deadlineRef = useRef<HTMLDivElement>(null);
  const deadlineTimeRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  /** Real candles (history + live ticks). */
  const candlesRef = useRef<Candle[] | null>(null);
  /** What is drawn for the last candle; eases toward the real one every frame. */
  const shownRef = useRef<Candle | null>(null);
  const stepRef = useRef(intervalMs(interval));
  const precisionRef = useRef<number | null>(null);
  /** Last tick's exchange time and when it arrived here: candles follow the exchange clock, not ours. */
  const feedClockRef = useRef<{ ts: number; at: number } | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const quote = useQuote(symbol);
  stepRef.current = intervalMs(interval);

  // Chart instance lives as long as the component.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        // Transparent: the black panel with the world map shows through (see .chart-map).
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: "'Inter Variable', system-ui, sans-serif",
        attributionLogo: false,
        // Oscillator panes: thin divider, draggable to resize.
        panes: { separatorColor: COLORS.border, separatorHoverColor: 'rgba(0,216,232,0.35)', enableResize: true },
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 14,
        barSpacing: 9,
        tickMarkFormatter: (t: number) => tickLabel(t, stepRef.current),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255,255,255,0.25)',
          labelBackgroundColor: COLORS.border,
        },
        horzLine: {
          color: 'rgba(255,255,255,0.25)',
          labelBackgroundColor: COLORS.border,
        },
      },
      localization: {
        locale: 'pt-BR',
        timeFormatter: (t: number) => crosshairLabel(t, stepRef.current),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      // Each series formats its own scale (indicator panes need their own decimals).
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (p: number) => formatPrice(p, precisionRef.current ?? pricePrecision(p)) },
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      // The animated tag below replaces the built-in last-value label.
      lastValueVisible: false,
      priceLineColor: 'rgba(255,255,255,0.5)',
      priceLineStyle: LineStyle.Dashed,
      visible: false,
    });
    const area = chart.addSeries(AreaSeries, {
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (p: number) => formatPrice(p, precisionRef.current ?? pricePrecision(p)) },
      lineColor: '#ffffff',
      lineWidth: 1,
      topColor: 'rgba(255,255,255,0.22)',
      bottomColor: 'rgba(255,255,255,0.0)',
      lastValueVisible: false,
      priceLineColor: 'rgba(255,255,255,0.5)',
      priceLineStyle: LineStyle.Dashed,
      crosshairMarkerBackgroundColor: COLORS.up,
      crosshairMarkerBorderColor: '#ffffff',
    });
    areaRef.current = area;
    chartRef.current = chart;
    rendererRef.current = new IndicatorRenderer(chart);
    seriesRef.current = series;
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      areaRef.current = null;
    };
  }, []);

  // History whenever the symbol or timeframe changes: a cached copy is drawn at once
  // (no spinner), then the fresh one from the API replaces it.
  useEffect(() => {
    const ctrl = new AbortController();
    const show = (list: Candle[]) => {
      const series = seriesRef.current;
      if (!series) return;
      const candles = list.slice();
      const last = candles.at(-1);
      if (last) {
        applyPrecision(series, precisionRef, last.c);
        if (areaRef.current) applyPrecision(areaRef.current, precisionRef, last.c);
      }
      series.setData(candles.map(toBar));
      areaRef.current?.setData(candles.map(toPoint));
      rendererRef.current?.setAll(candles, intervalMs(interval), precisionRef.current ?? 2);
      candlesRef.current = candles;
      shownRef.current = last ? { ...last } : null;
      // Dragging/zooming the price axis turns auto-scale off; a new asset or timeframe
      // must fit its own prices, not keep the previous range (BTC ~76k vs ETH ~2k).
      series.priceScale().applyOptions({ autoScale: true });
      setLoad({ status: 'ready' });
    };

    feedClockRef.current = null;
    precisionRef.current = null;
    const cached = cachedCandles(symbol, interval);
    if (cached) {
      show(cached);
      chartRef.current?.timeScale().scrollToRealTime();
    } else {
      candlesRef.current = null;
      shownRef.current = null;
      setLoad({ status: 'loading' });
      seriesRef.current?.setData([]);
      areaRef.current?.setData([]);
      rendererRef.current?.setAll([], intervalMs(interval), 2);
      seriesRef.current?.priceScale().applyOptions({ autoScale: true });
    }

    loadCandles(symbol, interval, CANDLE_LIMIT, ctrl.signal).then(
      (list) => {
        // A late answer for the previous asset/timeframe must not be drawn over the new one.
        if (ctrl.signal.aborted) return;
        show(list);
        if (!cached) chartRef.current?.timeScale().scrollToRealTime();
      },
      (err: unknown) => {
        if (ctrl.signal.aborted || cached) return;
        setLoad({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Não foi possível carregar o gráfico.',
        });
      },
    );
    return () => ctrl.abort();
  }, [symbol, interval, attempt]);

  // Each tick updates the real candle; the frame loop below animates the drawing toward it.
  useEffect(() => {
    const series = seriesRef.current;
    const candles = candlesRef.current;
    if (!series || !candles || !quote || quote.price === null || quote.stale) return;
    if (precisionRef.current === null) {
      applyPrecision(series, precisionRef, quote.price);
      if (areaRef.current) applyPrecision(areaRef.current, precisionRef, quote.price);
    }
    // Quiet pairs repeat the last trade (and its time) as a heartbeat; never pull the clock back.
    const at = performance.now();
    const clock = feedClockRef.current;
    if (!clock || quote.ts > clock.ts + (at - clock.at)) feedClockRef.current = { ts: quote.ts, at };
    const r = mergePrice(candles, quote.price, quote.ts, intervalMs(interval));
    if (r.kind === 'append') {
      // Close the previous candle at its exact final values before the new one opens.
      const prev = candles.at(-2);
      if (prev) {
        series.update(toBar(prev));
        areaRef.current?.update(toPoint(prev));
      }
      shownRef.current = seedCandle(r.candle);
      series.update(toBar(shownRef.current));
      areaRef.current?.update(toPoint(shownRef.current));
      rendererRef.current?.setAll(candles, intervalMs(interval), precisionRef.current ?? 2);
    } else if (r.kind === 'update') {
      if (!shownRef.current) {
        shownRef.current = { ...r.candle };
        series.update(toBar(r.candle));
        areaRef.current?.update(toPoint(r.candle));
      }
      rendererRef.current?.updateLast(candles);
    }
  }, [quote, interval, load]);

  // Frame loop: eases the last candle and keeps the overlays (price tag, order tags, result bubbles) in place.
  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let lastFrame = performance.now();
    let lastTagText = '';
    const hide = (el: HTMLElement | null) => {
      if (el) el.style.visibility = 'hidden';
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = now - lastFrame;
      lastFrame = now;
      const chart = chartRef.current;
      const series = seriesRef.current;
      const candles = candlesRef.current;
      const real = candles?.at(-1);
      let shown = shownRef.current;
      if (!chart || !series || !candles || !real || !shown) {
        hide(tagRef.current);
        hide(deadlineRef.current);
        for (const el of orderTagsRef.current?.children ?? []) hide(el as HTMLElement);
        for (const el of bubblesRef.current?.children ?? []) hide(el as HTMLElement);
        return;
      }
      const precision = precisionRef.current ?? pricePrecision(real.c);
      const next = stepCandle(shown, real, dt, reduceMotion.matches ? 0 : MOTION_TAU_MS, 10 ** -precision / 4);
      if (next !== shown) {
        shownRef.current = next;
        shown = next;
        series.update(toBar(next));
        areaRef.current?.update(toPoint(next));
      }

      const y = series.priceToCoordinate(shown.c);
      const plotWidth = chart.timeScale().width();
      const tag = tagRef.current;
      if (tag && y !== null) {
        // "9.58" plain, the last digits bigger and green/red with the candle, as on the Kyden tag.
        const text = formatPrice(shown.c, precision);
        const cut = Math.max(0, text.length - Math.min(4, precision));
        const key = `${text}|${shown.c >= shown.o ? 1 : 0}`;
        if (key !== lastTagText) {
          lastTagText = key;
          if (tagPriceRef.current) tagPriceRef.current.textContent = text.slice(0, cut);
          if (tagTimeRef.current) {
            tagTimeRef.current.textContent = text.slice(cut);
            tagTimeRef.current.style.color = shown.c >= shown.o ? COLORS.up : COLORS.down;
          }
        }
        tag.style.visibility = 'visible';
        tag.style.transform = `translate(${plotWidth - tag.offsetWidth - 4}px, ${Math.round(y)}px) translateY(-50%)`;
        // Small blinking dot on the current price, on the last candle (or the line's end).
        const dot = dotRef.current;
        const lx = chart.timeScale().logicalToCoordinate((candles.length - 1) as Logical);
        if (dot && lx !== null) {
          dot.style.visibility = 'visible';
          dot.style.transform = `translate(${Math.round(lx)}px, ${Math.round(y)}px)`;
        } else hide(dot);
      } else {
        hide(tag);
        hide(dotRef.current);
      }

      // "HORA DE COMPRA 00:25": time left to enter the current candle for the picked duration.
      const deadlineEl = deadlineRef.current;
      if (deadlineEl) {
        const serverNow = serverClock.serverNow();
        const { closesAt } = candleExpiry(serverNow, durationRef.current);
        const deadline = closesAt - LATE_ENTRY_MS;
        const lastIndex = candles.length - 1;
        const dx = logicalX(chart, lastIndex + (deadline - real.t) / stepRef.current);
        if (dx !== null && dx >= 0 && dx <= plotWidth) {
          deadlineEl.style.visibility = 'visible';
          deadlineEl.style.transform = `translateX(${Math.round(dx)}px)`;
          const t = purchaseCountdown(deadline - serverNow);
          if (deadlineTimeRef.current && deadlineTimeRef.current.textContent !== t) deadlineTimeRef.current.textContent = t;
        } else hide(deadlineEl);
      }

      // Order tags on the right edge, on each entry price line, coloured by live state.
      const tagsBox = orderTagsRef.current;
      if (tagsBox) {
        const serverNow = serverClock.serverNow();
        const height = chart.paneSize().height;
        const byId = new Map(ordersRef.current.map((o) => [o.id, o]));
        const placed: Array<{ el: HTMLElement; y: number }> = [];
        for (const el of tagsBox.children as HTMLCollectionOf<HTMLElement>) {
          const o = byId.get(el.dataset.order ?? '');
          const py = o ? series.priceToCoordinate(Number(o.openPrice)) : null;
          if (!o || py === null || py < 0 || py > height) {
            hide(el);
            continue;
          }
          const expires = parseServerTime(o.expiresAt);
          // Late entry still in its first candle: yellow until the candle that counts opens.
          const waiting = serverNow < expires - o.durationSec * 1000;
          if ((el.dataset.waiting === '1') !== waiting) {
            if (waiting) el.dataset.waiting = '1';
            else delete el.dataset.waiting;
            linesRef.current.get(o.id)?.applyOptions({ color: lineColor(o, waiting) });
          }
          const time = formatCountdown(Math.max(0, expires - serverNow));
          const timeEl = el.lastElementChild as HTMLElement;
          if (timeEl.textContent !== time) timeEl.textContent = time;
          placed.push({ el, y: py });
        }
        // Stack tags that would overlap, top to bottom.
        placed.sort((a, b) => a.y - b.y);
        let floor = -Infinity;
        for (const { el, y } of placed) {
          const h = el.offsetHeight || 18;
          const top = Math.max(Math.round(y - h / 2), floor);
          floor = top + h + 2;
          el.style.visibility = 'visible';
          el.style.transform = `translate(${Math.round(plotWidth - el.offsetWidth - 6)}px, ${top}px)`;
        }
      }

      // Result bubbles where orders expired: above the close price, at the expiry time.
      const bubbleBox = bubblesRef.current;
      if (bubbleBox) {
        const lastIndex = candles.length - 1;
        for (const el of bubbleBox.children as HTMLCollectionOf<HTMLElement>) {
          const expires = Number(el.dataset.expires);
          const lx = logicalX(chart, lastIndex + (expires - real.t) / stepRef.current);
          const py = series.priceToCoordinate(Number(el.dataset.price));
          if (lx === null || py === null || lx < 0 || lx > plotWidth) {
            hide(el);
            continue;
          }
          el.style.visibility = 'visible';
          el.style.transform = `translate(${Math.round(lx - el.offsetWidth / 2)}px, ${Math.round(py - el.offsetHeight - 10)}px)`;
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Entry price lines for this symbol's open orders: green for a buy, red for a sell.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const now = serverClock.serverNow();
    const lines: IPriceLine[] = orders.map((o) =>
      series.createPriceLine({
        price: Number(o.openPrice),
        color: lineColor(o, now < parseServerTime(o.expiresAt) - o.durationSec * 1000),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      }),
    );
    linesRef.current = new Map(orders.map((o, i) => [o.id, lines[i] as IPriceLine]));
    return () => {
      for (const l of lines) series.removePriceLine(l);
      linesRef.current = new Map();
    };
  }, [orders]);

  // Line or candles: both series always hold the same data; only one is shown.
  useEffect(() => {
    seriesRef.current?.applyOptions({ visible: chartType === 'candles' });
    areaRef.current?.applyOptions({ visible: chartType === 'line' });
  }, [chartType]);
  const toggleChartType = useCallback(() => {
    setChartType((t) => {
      const next = t === 'line' ? 'candles' : 'line';
      store(CHART_TYPE_KEY, next);
      return next;
    });
  }, []);

  // Empty space right of the last price (about 40% of the view, as on the Kyden platform),
  // never less than what the expiry line of the picked duration needs.
  const applySpan = useCallback(
    (min: number) => {
      const chart = chartRef.current;
      const n = candlesRef.current?.length ?? 0;
      if (!chart || n === 0) return;
      const step = intervalMs(interval);
      const bars = Math.max(10, Math.round((min * 60_000) / step));
      const right = Math.max(Math.round(bars * 0.66), Math.ceil((durationRef.current * 2000) / step) + 4);
      chart.timeScale().applyOptions({ rightOffset: right });
      chart.timeScale().setVisibleLogicalRange({ from: (n - 1 - bars) as Logical, to: (n - 1 + right) as Logical });
    },
    [interval],
  );
  useEffect(() => {
    if (load.status === 'ready') applySpan(SPAN_MIN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationSec]);
  // Each asset/timeframe opens at the default zoom once its history is in.
  useEffect(() => {
    if (load.status === 'ready') applySpan(SPAN_MIN);
  }, [load.status, symbol, interval, applySpan]);

  // Indicator series follow the user's list (rebuilt only when it changes).
  useEffect(() => {
    rendererRef.current?.sync(indicators.list);
  }, [indicators.list]);

  const bubbles = useMemo(() => resultBubbles(results, symbol), [results, symbol]);

  const toolBtn =
    'flex size-[34px] items-center justify-center rounded-[3px] border border-[#3a4049] bg-[#12171e]/80 text-[13px] font-bold text-[#d5d7da] hover:border-[#5a616b] hover:text-white';
  return (
    <div className="flex h-full min-h-[220px] lg:min-h-[320px]">
      <div ref={hostRef} className="chart-map relative min-w-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="absolute inset-0"
          role="img"
          aria-label={`Gráfico ${chartType === 'line' ? 'de linha' : 'de velas'} de ${display}, intervalo ${interval}`}
        />
        {/* Bottom-left tools, as on the Kyden platform: chart type, interval, indicators, drawing. */}
        <div className="absolute bottom-[34px] left-[10px] z-30 flex flex-col gap-[8px]">
          <button
            type="button"
            className={toolBtn}
            aria-label={chartType === 'line' ? 'Mudar para velas' : 'Mudar para linha'}
            title={chartType === 'line' ? 'Velas' : 'Linha'}
            onClick={() => toggleChartType()}
          >
            {chartType === 'line' ? (
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 17l5-6 4 3 5-8 4 4" />
                <path d="M3 21h18" opacity="0.5" />
              </svg>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
                <path d="M6 3h1.5v4H9v9H7.5v5H6v-5H4.5V7H6V3zm9 3h1.5v3H18v8h-1.5v4H15v-4h-1.5V9H15V6z" />
              </svg>
            )}
          </button>
          {toolbarTop}
          <IndicatorsButton onClick={() => setPickerOpen(true)} />
          <div className="relative hidden sm:block">
            <button
              type="button"
              className={cx(toolBtn, drawOpen && 'border-[#5a616b] text-white')}
              aria-label="Ferramentas de desenho"
              aria-expanded={drawOpen}
              title="Desenhar"
              onClick={() => setDrawOpen((v) => !v)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[17px]" fill="currentColor">
                <path d="M15.6 3.6l4.8 4.8L9 19.8 3 21l1.2-6L15.6 3.6zM4 22h16v-1.6H4z" />
              </svg>
            </button>
            {drawOpen && (
              <div className="absolute bottom-0 left-full ml-2 rounded-[3px] border border-[#3a4049] bg-[#12171e] px-1">
                <DrawingToolbar
                  state={drawings}
                  onClearAll={() => {
                    drawings.commit([]);
                    drawings.select(null);
                  }}
                />
              </div>
            )}
          </div>
        </div>
        <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          <div ref={dotRef} className="invisible absolute top-0 left-0">
            <span className="kd-dot-ring absolute -top-[5px] -left-[5px] size-[10px] rounded-full bg-white" />
            <span className="kd-dot absolute -top-[3px] -left-[3px] size-[6px] rounded-full bg-white shadow-[0_0_6px_rgb(255_255_255/0.8)]" />
          </div>
          <div ref={deadlineRef} className="invisible absolute top-0 bottom-[28px] left-0 w-0">
            <div className="absolute top-[14px] right-[6px] flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-right text-[9.5px] leading-[1.15] font-medium text-[#d5d7da] uppercase">
                Hora de
                <br />
                compra
              </span>
              <span ref={deadlineTimeRef} className="tabular text-[22px] leading-none font-normal text-white" />
            </div>
          </div>
          <div
            ref={tagRef}
            className="invisible absolute top-0 left-0 flex h-[26px] items-center bg-[#cfd0d2] pr-2 pl-3.5 leading-none text-[#3b4048] [clip-path:polygon(9px_0,100%_0,100%_100%,9px_100%,0_50%)]"
          >
            <span ref={tagPriceRef} className="tabular text-[12px]" />
            <span ref={tagTimeRef} className="tabular text-[15px] font-bold" />
          </div>
          <div ref={orderTagsRef} data-testid="order-tags">
            {orders.map((o) => (
              <div key={o.id} className="order-tag" data-order={o.id} data-direction={o.direction}>
                <span className="order-tag-label">
                  {TAG_LABEL[o.direction]} {formatMoney(o.stakeCents)}
                </span>
                <span className="order-tag-time" />
              </div>
            ))}
          </div>
          <div ref={bubblesRef}>
            {bubbles.map((b) => (
              <div key={b.key} className="result-bubble" data-expires={b.expires} data-price={b.price}>
                <small>Resultado</small>
                {formatSignedMoney(b.netCents)}
              </div>
            ))}
          </div>
        </div>
        <OverlayLayer
          hostRef={hostRef}
          chartRef={chartRef}
          seriesRef={seriesRef}
          candlesRef={candlesRef}
          stepRef={stepRef}
          configs={indicators.list}
          symbol={symbol}
        />
        <DrawingLayer
          hostRef={hostRef}
          chartRef={chartRef}
          seriesRef={seriesRef}
          candlesRef={candlesRef}
          stepRef={stepRef}
          state={drawings}
        />
        <IndicatorLegend rendererRef={rendererRef} hostRef={hostRef} state={indicators} onSettings={setEditingIndicator} />
        <IndicatorsDialog open={pickerOpen} onClose={() => setPickerOpen(false)} state={indicators} />
        <IndicatorSettings
          cfg={editingIndicator}
          onClose={() => setEditingIndicator(null)}
          onSave={(c) => {
            indicators.update(c);
            setEditingIndicator(null);
          }}
        />
        {load.status === 'loading' && (
          <div className="absolute inset-0 z-20 bg-bg/80">
            <LoadingState label="Carregando gráfico…" className="h-full" />
          </div>
        )}
        {load.status === 'error' && (
          <div className="absolute inset-0 z-20 bg-bg">
            <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} className="h-full" />
          </div>
        )}
        {load.status === 'ready' && candlesRef.current?.length === 0 && quote?.price == null && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center text-sm text-muted">
            Sem dados de preço para este ativo ainda.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * X for a fractional bar index. lightweight-charts only maps whole indexes (a fraction
 * comes back as 0), so interpolate between the two neighbouring bars.
 */
function logicalX(chart: IChartApi, logical: number): number | null {
  const ts = chart.timeScale();
  const base = Math.floor(logical);
  const a = ts.logicalToCoordinate(base as Logical);
  if (a === null) return null;
  const frac = logical - base;
  if (frac === 0) return a;
  const b = ts.logicalToCoordinate((base + 1) as Logical);
  if (b === null) return null;
  return a + (b - a) * frac;
}

function applyPrecision(series: ISeriesApi<'Candlestick'> | ISeriesApi<'Area'>, ref: { current: number | null }, price: number): void {
  const precision = pricePrecision(price);
  ref.current = precision;
  series.applyOptions({
    priceFormat: { type: 'custom', minMove: 10 ** -precision, formatter: (p: number) => formatPrice(p, precision) },
  });
}
