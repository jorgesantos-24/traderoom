import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
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
import type { Candle, CandleInterval, CandleMark, OrderView } from '@traderoom/shared';
import { ApiError } from '../lib/api';
import { cachedCandles, cachedMarks, loadCandles } from '../lib/candle-cache';
import { MOTION_TAU_MS, seedCandle, stepCandle } from '../lib/candle-motion';
import { intervalMs, mergePrice } from '../lib/candles';
import { crosshairLabel, tickLabel } from '../lib/chart-time';
import { resultBubbles } from '../lib/chart-orders';
import { serverClock, parseServerTime } from '../lib/clock';
import { formatCountdown, formatMoney, formatPrice, formatSignedMoney, pricePrecision } from '../lib/format';
import { useQuote } from '../lib/session-data';
import { platformPriceUntil, usePlatformPrice } from '../lib/use-platform-price';
import type { ResultToast } from '../lib/use-trade-orders';
import { useDrawings } from '../lib/use-drawings';
import { IndicatorRenderer } from '../lib/indicator-series';
import type { IndicatorConfig } from '../lib/indicators';
import { useIndicators } from '../lib/use-indicators';
import { IndicatorLegend, IndicatorSettings, IndicatorsButton, IndicatorsDialog } from './Indicators';
import { DrawingLayer } from './DrawingLayer';
import { OverlayLayer } from './OverlayLayer';
import { DrawingToolbar } from './DrawingToolbar';
import { ErrorState, LoadingState } from './ui';

const COLORS = {
  grid: 'rgba(255,255,255,0.035)',
  border: '#2a2c32',
  text: '#d2d0d7',
  up: '#44b53a',
  down: '#ff4122',
  brand: '#00d8e8',
};
export const CANDLE_LIMIT = 500;

/** Order tags on the chart use the trading terms traders know. */
const TAG_LABEL = { call: 'Buy', put: 'Sell' } as const;

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
  /** Shown above the drawing tools (the timeframe picker). */
  toolbarTop?: ReactNode;
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export function PriceChart({ symbol, display, interval, orders, results, toolbarTop }: Props) {
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
  const markColsRef = useRef<HTMLDivElement>(null);
  const markDotsRef = useRef<HTMLDivElement>(null);
  /** Candles whose close the platform set (price override); they keep the mark after it ends. */
  const [marks, setMarks] = useState<CandleMark[]>([]);
  const [hoverMark, setHoverMark] = useState<number | null>(null);
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
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
  const platform = usePlatformPrice(symbol, quote?.ov);
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
        vertLines: { visible: false },
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
      priceLineColor: 'rgba(0,216,232,0.55)',
      priceLineStyle: LineStyle.Dotted,
    });
    chartRef.current = chart;
    rendererRef.current = new IndicatorRenderer(chart);
    seriesRef.current = series;
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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
      if (last) applyPrecision(series, precisionRef, last.c);
      series.setData(candles.map(toBar));
      rendererRef.current?.setAll(candles, intervalMs(interval), precisionRef.current ?? 2);
      candlesRef.current = candles;
      shownRef.current = last ? { ...last } : null;
      setMarks(cachedMarks(symbol, interval));
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
      setMarks([]);
      setLoad({ status: 'loading' });
      seriesRef.current?.setData([]);
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

  // When the live override ends, its candle gets the permanent mark: ask for the marks again.
  const platformOn = platform !== null;
  const platformWasOn = useRef(false);
  useEffect(() => {
    const ended = platformWasOn.current && !platformOn;
    platformWasOn.current = platformOn;
    if (!ended) return;
    const ctrl = new AbortController();
    loadCandles(symbol, interval, CANDLE_LIMIT, ctrl.signal).then(
      () => setMarks(cachedMarks(symbol, interval)),
      () => {},
    );
    return () => ctrl.abort();
  }, [platformOn, symbol, interval]);

  // Tooltip of a marked candle while the crosshair is on it.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const marked = new Set(marks.map((m) => m.openMs));
    const onMove = (param: { time?: unknown }) => {
      const t = typeof param.time === 'number' ? param.time * 1000 : null;
      setHoverMark(t !== null && marked.has(t) ? t : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [marks]);

  // Each tick updates the real candle; the frame loop below animates the drawing toward it.
  useEffect(() => {
    const series = seriesRef.current;
    const candles = candlesRef.current;
    if (!series || !candles || !quote || quote.price === null || quote.stale) return;
    if (precisionRef.current === null) applyPrecision(series, precisionRef, quote.price);
    // Quiet pairs repeat the last trade (and its time) as a heartbeat; never pull the clock back.
    const at = performance.now();
    const clock = feedClockRef.current;
    if (!clock || quote.ts > clock.ts + (at - clock.at)) feedClockRef.current = { ts: quote.ts, at };
    const r = mergePrice(candles, quote.price, quote.ts, intervalMs(interval));
    if (r.kind === 'append') {
      // Close the previous candle at its exact final values before the new one opens.
      const prev = candles.at(-2);
      if (prev) series.update(toBar(prev));
      shownRef.current = seedCandle(r.candle);
      series.update(toBar(shownRef.current));
      rendererRef.current?.setAll(candles, intervalMs(interval), precisionRef.current ?? 2);
    } else if (r.kind === 'update') {
      if (!shownRef.current) {
        shownRef.current = { ...r.candle };
        series.update(toBar(r.candle));
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
        for (const el of orderTagsRef.current?.children ?? []) hide(el as HTMLElement);
        for (const el of bubblesRef.current?.children ?? []) hide(el as HTMLElement);
        for (const el of markColsRef.current?.children ?? []) hide(el as HTMLElement);
        for (const el of markDotsRef.current?.children ?? []) hide(el as HTMLElement);
        return;
      }
      const precision = precisionRef.current ?? pricePrecision(real.c);
      const next = stepCandle(shown, real, dt, reduceMotion.matches ? 0 : MOTION_TAU_MS, 10 ** -precision / 4);
      if (next !== shown) {
        shownRef.current = next;
        shown = next;
        series.update(toBar(next));
      }

      const y = series.priceToCoordinate(shown.c);
      const plotWidth = chart.timeScale().width();
      const tag = tagRef.current;
      if (tag && y !== null) {
        const feed = feedClockRef.current;
        const exchangeNow = feed ? feed.ts + (now - feed.at) : serverClock.serverNow();
        const candleLeftMs = Math.max(0, real.t + stepRef.current - exchangeNow);
        const text = `${formatPrice(shown.c, precision)}|${formatCountdown(candleLeftMs)}`;
        if (text !== lastTagText) {
          lastTagText = text;
          const [p, t] = text.split('|');
          if (tagPriceRef.current) tagPriceRef.current.textContent = p ?? '';
          if (tagTimeRef.current) tagTimeRef.current.textContent = t ?? '';
        }
        tag.style.visibility = 'visible';
        tag.style.transform = `translate(${plotWidth}px, ${Math.round(y)}px) translateY(-50%)`;
        tag.style.background = shown.c >= shown.o ? COLORS.up : COLORS.down;
      } else hide(tag);

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
          const time = formatCountdown(Math.max(0, parseServerTime(o.expiresAt) - serverNow));
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

      // Override marks: the bar's column, tinted, and a dot just above its high.
      const cols = markColsRef.current?.children as HTMLCollectionOf<HTMLElement> | undefined;
      const dots = markDotsRef.current?.children as HTMLCollectionOf<HTMLElement> | undefined;
      if (cols && dots) {
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i] as HTMLElement;
          const dot = dots[i];
          const idx = candleIndex(candles, Number(col.dataset.open));
          const x = idx === null ? null : logicalX(chart, idx);
          const x1 = idx === null ? null : logicalX(chart, idx + 1);
          const high = idx === null ? undefined : idx === candles.length - 1 ? Math.max(shown.h, shown.o, shown.c) : candles[idx]?.h;
          const py = high === undefined ? null : series.priceToCoordinate(high);
          if (x === null || x1 === null || py === null || x < -50 || x > plotWidth + 50) {
            hide(col);
            if (dot) hide(dot);
            continue;
          }
          const w = Math.max(2, Math.abs(x1 - x));
          col.style.visibility = 'visible';
          col.style.width = `${w}px`;
          col.style.transform = `translateX(${Math.round(x - w / 2)}px)`;
          if (dot) {
            dot.style.visibility = 'visible';
            dot.style.transform = `translate(${Math.round(x - 2.5)}px, ${Math.round(py - 11)}px)`;
          }
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
    const lines: IPriceLine[] = orders.map((o) =>
      series.createPriceLine({
        price: Number(o.openPrice),
        color: o.direction === 'call' ? COLORS.up : COLORS.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      }),
    );
    return () => {
      for (const l of lines) series.removePriceLine(l);
    };
  }, [orders]);

  // Indicator series follow the user's list (rebuilt only when it changes).
  useEffect(() => {
    rendererRef.current?.sync(indicators.list);
  }, [indicators.list]);

  const bubbles = useMemo(() => resultBubbles(results, symbol), [results, symbol]);

  return (
    <div className="flex h-full min-h-[220px] lg:min-h-[320px]">
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border pt-2 sm:w-12">
        {toolbarTop}
        <IndicatorsButton onClick={() => setPickerOpen(true)} />
        {/* Drawing needs a precise pointer and room; phones get the chart instead. */}
        <div className="hidden flex-col items-center gap-1 sm:flex">
          <div className="h-px w-6 bg-border" />
          <DrawingToolbar
            state={drawings}
            onClearAll={() => {
              drawings.commit([]);
              drawings.select(null);
            }}
          />
        </div>
      </div>
      <div ref={hostRef} className="chart-map relative min-w-0 flex-1 overflow-hidden">
        {/* Under the chart (its background is transparent), so the tint sits behind the candles. */}
        <div ref={markColsRef} className="pointer-events-none absolute inset-0" aria-hidden="true">
          {marks.map((m) => (
            <div key={m.openMs} className="override-col" data-open={m.openMs} />
          ))}
        </div>
        <div
          ref={containerRef}
          className="absolute inset-0"
          role="img"
          aria-label={`Gráfico de velas de ${display}, intervalo ${interval}`}
        />
        <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          <div
            ref={tagRef}
            className="invisible absolute top-0 left-0 flex flex-col items-start rounded-r-md px-2 py-0.5 leading-tight text-bg shadow-lg"
          >
            <span ref={tagPriceRef} className="tabular text-xs font-bold" />
            <span ref={tagTimeRef} className="tabular text-[10px] font-semibold opacity-80" />
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
          <div ref={markDotsRef} data-testid="override-marks">
            {marks.map((m) => (
              <div key={m.openMs} className="override-dot" data-open={m.openMs} data-direction={m.direction}>
                {hoverMark === m.openMs && (
                  <div className="override-tip">
                    Preço definido pela plataforma · alvo{' '}
                    <span className="tabular">{formatPrice(m.targetPrice, precisionRef.current ?? pricePrecision(m.targetPrice))}</span>
                  </div>
                )}
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
        {platform && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-8 left-2 z-10 rounded-control border border-warn/40 bg-bg/90 px-2 py-0.5 text-[11px] text-warn"
            data-testid="chart-platform-price"
          >
            Preço da plataforma · {platformPriceUntil(platform.untilMs)}
          </div>
        )}
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

/** Index of the candle that opens at `t` (candles are sorted by time), or null. */
function candleIndex(candles: readonly Candle[], t: number): number | null {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = (candles[mid] as Candle).t;
    if (ct === t) return mid;
    if (ct < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function applyPrecision(series: ISeriesApi<'Candlestick'>, ref: { current: number | null }, price: number): void {
  const precision = pricePrecision(price);
  ref.current = precision;
  series.applyOptions({
    priceFormat: { type: 'custom', minMove: 10 ** -precision, formatter: (p: number) => formatPrice(p, precision) },
  });
}
