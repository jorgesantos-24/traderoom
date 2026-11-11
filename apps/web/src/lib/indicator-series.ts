import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@traderoom/shared';
import { INDICATOR_BY_TYPE, outputOffset, type IndicatorConfig, type IndicatorDef, type Values } from './indicators';

/** Pane height for each oscillator, relative to the candles pane (1). */
const OWN_PANE_STRETCH = 0.32;

const MACD_HIST = { upRising: '#26a69a', upFalling: '#b2dfdb', downRising: '#ffcdd2', downFalling: '#ff5252' };
/** Awesome Oscillator bars: green while rising, red while falling (TradingView's colors). */
const AO_BARS = { rising: '#089981', falling: '#f23645' };

interface Built {
  cfg: IndicatorConfig;
  def: IndicatorDef;
  pane: number;
  series: Map<string, ISeriesApi<SeriesType>>;
  /** Latest computed values (per output), for the legend. */
  values: Record<string, Values>;
}

export interface LegendValue {
  label: string;
  color: string;
  text: string;
}
export interface LegendItem {
  cfg: IndicatorConfig;
  values: LegendValue[];
}
export interface LegendPane {
  pane: number;
  top: number;
  items: LegendItem[];
}

const toTime = (ms: number) => (ms / 1000) as UTCTimestamp;

/** Owns the indicator series on a chart: builds panes, feeds values, answers the legend. */
export class IndicatorRenderer {
  private built: Built[] = [];
  private signature = '';
  private candles: readonly Candle[] = [];
  private step = 60_000;
  private precision = 2;
  /** Candle index under the crosshair, or null for the latest. */
  private hoverIndex: number | null = null;

  constructor(private readonly chart: IChartApi) {
    chart.subscribeCrosshairMove(this.onCrosshair);
  }

  dispose(): void {
    this.chart.unsubscribeCrosshairMove(this.onCrosshair);
  }

  private onCrosshair = (param: MouseEventParams<Time>) => {
    if (param.time === undefined || this.candles.length === 0) {
      this.hoverIndex = null;
      return;
    }
    const t = (param.time as number) * 1000;
    const first = this.candles[0]!.t;
    const i = Math.round((t - first) / this.step);
    this.hoverIndex = i >= 0 && i < this.candles.length ? i : null;
  };

  /** Rebuilds series and panes when the set of indicators or their settings changed. */
  sync(configs: readonly IndicatorConfig[]): void {
    const sig = JSON.stringify(configs.map((c) => [c.id, c.type, c.params, c.colors]));
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuild(configs);
      this.setAll(this.candles, this.step, this.precision);
    }
    // Visibility only toggles series, no rebuild.
    for (const b of this.built) {
      const cfg = configs.find((c) => c.id === b.cfg.id);
      if (!cfg) continue;
      b.cfg = cfg;
      for (const s of b.series.values()) s.applyOptions({ visible: cfg.visible });
    }
  }

  private rebuild(configs: readonly IndicatorConfig[]): void {
    for (const b of this.built) for (const s of b.series.values()) this.chart.removeSeries(s);
    this.built = [];
    // Drop the oscillator panes (from the bottom up, so indexes stay valid).
    for (let i = this.chart.panes().length - 1; i > 0; i--) this.chart.removePane(i);

    let nextPane = 1;
    for (const cfg of configs) {
      const def = INDICATOR_BY_TYPE.get(cfg.type);
      if (!def) continue;
      const pane = def.pane === 'main' ? 0 : nextPane++;
      const series = new Map<string, ISeriesApi<SeriesType>>();
      // Overlays (SMC) draw themselves on a canvas; they only take part in the legend.
      for (const out of def.overlay ? [] : def.outputs) {
        const color = cfg.colors[out.key] ?? out.color;
        const common = {
          color,
          visible: cfg.visible,
          priceLineVisible: false,
          lastValueVisible: true,
          title: '',
        };
        const s =
          out.kind === 'histogram'
            ? this.chart.addSeries(HistogramSeries, { ...common, base: 0 }, pane)
            : this.chart.addSeries(
                LineSeries,
                {
                  ...common,
                  lineWidth: out.width ?? 1,
                  crosshairMarkerVisible: out.kind !== 'dots',
                  ...(out.kind === 'dots'
                    ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5, lastValueVisible: false }
                    : {}),
                },
                pane,
              );
        series.set(out.key, s);
      }
      // Reference levels (RSI 70/30, …) on the pane's first line.
      const first = [...series.values()].find((s) => s.seriesType() === 'Line');
      for (const lvl of def.levels ?? []) {
        first?.createPriceLine({
          price: lvl,
          color: 'rgba(255,255,255,0.28)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        });
      }
      this.built.push({ cfg, def, pane, series, values: {} });
    }
    const panes = this.chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i]!.setStretchFactor(OWN_PANE_STRETCH);
  }

  /** Full recompute and redraw (new history, new asset or timeframe, or a new candle). */
  setAll(candles: readonly Candle[], step: number, precision: number): void {
    this.candles = candles;
    this.step = step;
    this.precision = precision;
    for (const b of this.built) {
      if (b.def.overlay) continue;
      b.values = candles.length ? b.def.compute(candles, b.cfg.params) : {};
      const precision = this.precisionOf(b.def);
      const fmt = {
        type: 'custom' as const,
        minMove: 10 ** -precision,
        formatter: (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: precision, maximumFractionDigits: precision }),
      };
      for (const out of b.def.outputs) {
        const s = b.series.get(out.key)!;
        s.applyOptions({ priceFormat: fmt });
        s.setData(this.points(b, out.key));
      }
    }
  }

  /** The last candle changed: update just the newest point of each output. */
  updateLast(candles: readonly Candle[]): void {
    this.candles = candles;
    const last = candles.length - 1;
    if (last < 0) return;
    for (const b of this.built) {
      if (b.def.overlay) continue;
      b.values = b.def.compute(candles, b.cfg.params);
      for (const out of b.def.outputs) {
        const v = b.values[out.key]?.[last];
        const off = outputOffset(b.def, out.key, b.cfg.params);
        const time = toTime(candles[last]!.t + off * this.step);
        // A broken line (Supertrend) whose trend just flipped drops the live point.
        if (v == null) {
          if (out.breaks) b.series.get(out.key)!.update({ time });
          continue;
        }
        b.series.get(out.key)!.update(this.point(b, out.key, last, time, v));
      }
    }
  }

  private precisionOf(def: IndicatorDef): number {
    // Same decimals as TradingView: price-based indicators (MAs, MACD, ATR) like the asset, oscillators 2.
    return def.priceScaled ? this.precision : 2;
  }

  private point(b: Built, key: string, i: number, time: UTCTimestamp, v: number) {
    if (b.def.type === 'macd' && key === 'hist') {
      const prev = b.values.hist?.[i - 1];
      const rising = prev == null || v > prev;
      const color = v >= 0 ? (rising ? MACD_HIST.upRising : MACD_HIST.upFalling) : rising ? MACD_HIST.downRising : MACD_HIST.downFalling;
      return { time, value: v, color };
    }
    if (b.def.type === 'ao') {
      const prev = b.values[key]?.[i - 1];
      return { time, value: v, color: prev != null && v <= prev ? AO_BARS.falling : AO_BARS.rising };
    }
    return { time, value: v };
  }

  private points(b: Built, key: string) {
    const vals = b.values[key] ?? [];
    const off = outputOffset(b.def, key, b.cfg.params);
    const breaks = b.def.outputs.find((o) => o.key === key)?.breaks === true;
    const out = [];
    let started = false;
    // Shifted back (Ichimoku's lagging span): nothing before the first candle, or the bars would move.
    for (let i = Math.max(0, -off); i < vals.length; i++) {
      const v = vals[i];
      const time = toTime(this.candles[i]!.t + off * this.step);
      if (v == null) {
        // Whitespace breaks the line; without it lightweight-charts joins across the gap.
        if (breaks && started) out.push({ time });
        continue;
      }
      started = true;
      out.push(this.point(b, key, i, time, v));
    }
    return out;
  }

  /** Legend contents: each pane's top (px from the chart top) and its indicators' values. */
  legend(host: HTMLElement): LegendPane[] {
    const hostTop = host.getBoundingClientRect().top;
    const panes = this.chart.panes();
    const index = this.hoverIndex ?? this.candles.length - 1;
    const byPane = new Map<number, LegendItem[]>();
    for (const b of this.built) {
      const values = (b.def.overlay ? [] : b.def.outputs).map((out) => {
        // With an offset, the value drawn at this bar was computed `off` bars earlier.
        const off = outputOffset(b.def, out.key, b.cfg.params);
        const v = b.values[out.key]?.[index - off];
        const precision = this.precisionOf(b.def);
        return {
          label: out.label,
          color: b.cfg.colors[out.key] ?? out.color,
          text: v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: precision, maximumFractionDigits: precision }),
        };
      });
      const list = byPane.get(b.pane) ?? [];
      list.push({ cfg: b.cfg, values });
      byPane.set(b.pane, list);
    }
    return [...byPane.entries()].map(([pane, items]) => {
      const el = panes[pane]?.getHTMLElement();
      const top = el ? el.getBoundingClientRect().top - hostTop : 0;
      return { pane, top, items };
    });
  }
}
