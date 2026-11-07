import { useEffect, useRef, useState, type RefObject } from 'react';
import { CrosshairMode, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Candle } from '@traderoom/shared';
import {
  channelOffset,
  DRAW_COLORS,
  defaultColor,
  EMOJI_PX,
  extendLine,
  FIB_COLORS,
  FIB_LEVELS,
  fibPrice,
  hitTest,
  isDrawingType,
  pointsNeeded,
  TEXT_FONT_PX,
  type Drawing,
  type Hit,
  type Pt,
  type XY,
} from '../lib/drawings';
import { createMapper, type Mapper } from '../lib/chart-mapper';
import { formatPrice, pricePrecision } from '../lib/format';
import type { DrawingState } from '../lib/use-drawings';
import { cx } from './ui';

interface Props {
  hostRef: RefObject<HTMLDivElement | null>;
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>;
  candlesRef: RefObject<Candle[] | null>;
  stepRef: RefObject<number>;
  state: DrawingState;
}

const FONT = "'Inter Variable', system-ui, sans-serif";
const MAGNET_PX = 30;
const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36);

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})`;
}

function durationLabel(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Canvas over the candles where the trader draws; also handles selection, dragging, ruler and area zoom. */
export function DrawingLayer({ hostRef, chartRef, seriesRef, candlesRef, stepRef, state }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const draftRef = useRef<Drawing | null>(null);
  const downRef = useRef<XY | null>(null);
  const dragRef = useRef<{
    id: string;
    hit: Hit;
    start: Pt;
    orig: Pt[];
  } | null>(null);
  const rulerRef = useRef<{ a: Pt; b: Pt; done: boolean } | null>(null);
  const zoomRef = useRef<{ a: XY; b: XY } | null>(null);
  const [editing, setEditing] = useState<{
    drawing: Drawing;
    x: number;
    y: number;
    isNew: boolean;
  } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Pointer cursor hides the crosshair; every other tool keeps it.
  useEffect(() => {
    chartRef.current?.applyOptions({
      crosshair: {
        mode: state.tool === 'pointer' ? CrosshairMode.Hidden : CrosshairMode.Normal,
      },
    });
  }, [state.tool, chartRef]);

  // Leaving a drawing tool drops the half-placed drawing.
  useEffect(() => {
    if (!isDrawingType(state.tool)) draftRef.current = null;
    if (state.tool !== 'ruler') rulerRef.current = null;
  }, [state.tool]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const mapper = (): Mapper | null => createMapper(chartRef.current, seriesRef.current, candlesRef.current, stepRef.current);

    const toXY = (m: Mapper, p: Pt): XY | null => {
      const y = m.toY(p.p);
      return y === null ? null : { x: m.toX(p.t), y };
    };
    const screenPts = (m: Mapper, d: Drawing): XY[] | null => {
      const out: XY[] = [];
      for (const p of d.pts) {
        const s = toXY(m, p);
        if (!s) return null;
        out.push(s);
      }
      return out;
    };

    /** Chart point under the pointer; with the magnet on, snaps to the bar and its nearest O/H/L/C. */
    const toPt = (m: Mapper, pos: XY, snap = stateRef.current.magnet): Pt | null => {
      const p = m.toP(pos.y);
      if (p === null) return null;
      let pt: Pt = { t: m.toT(pos.x), p };
      if (snap) {
        const c = m.candles[m.lastIdx + Math.round((pos.x - m.xLast) / m.spacing)];
        if (c) {
          pt = { t: c.t, p };
          let best = MAGNET_PX;
          for (const v of [c.o, c.h, c.l, c.c]) {
            const y = m.toY(v);
            if (y !== null && Math.abs(y - pos.y) < best) {
              best = Math.abs(y - pos.y);
              pt = { t: c.t, p: v };
            }
          }
        }
      }
      return pt;
    };

    const hitAll = (m: Mapper, pos: XY): { d: Drawing; hit: Hit } | null => {
      const s = stateRef.current;
      if (s.hidden) return null;
      // Selected first, then top-most.
      const list = [...s.drawings].reverse().sort((a, b) => Number(b.id === s.selectedId) - Number(a.id === s.selectedId));
      for (const d of list) {
        const sp = screenPts(m, d);
        if (!sp) continue;
        const hit = hitTest(d, sp, pos, m.w, m.h);
        if (hit) return { d, hit };
      }
      return null;
    };

    const local = (e: PointerEvent | MouseEvent): XY => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = (m: Mapper, pos: XY) => pos.x >= 0 && pos.y >= 0 && pos.x < m.w && pos.y < m.h;
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const finishDraft = () => {
      const d = draftRef.current;
      draftRef.current = null;
      if (!d) return;
      const s = stateRef.current;
      s.commit([...s.drawings, d]);
      s.select(d.id);
      if (!s.stay) s.setTool('cross');
    };
    const confirmPoint = () => {
      const d = draftRef.current;
      if (!d) return;
      if (d.pts.length >= pointsNeeded(d.type)) finishDraft();
      else d.pts.push({ ...d.pts.at(-1)! });
    };

    const openText = (m: Mapper, d: Drawing, isNew: boolean) => {
      const a = toXY(m, d.pts[0]!);
      if (a) setEditing({ drawing: d, x: a.x, y: a.y, isNew });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || editingRef.current) return;
      const m = mapper();
      if (!m) return;
      const pos = local(e);
      if (!inPlot(m, pos)) return;
      const s = stateRef.current;
      const tool = s.tool;

      if (isDrawingType(tool)) {
        swallow(e);
        if (s.hidden) s.toggleHidden();
        const pt = toPt(m, pos);
        if (!pt) return;
        const needed = pointsNeeded(tool);
        const color = defaultColor(tool);
        if (needed === 0) {
          draftRef.current = { id: newId(), type: tool, pts: [pt], color };
        } else if (needed === 1) {
          const d: Drawing = {
            id: newId(),
            type: tool,
            pts: [pt],
            color,
            ...(tool === 'emoji' ? { text: s.emoji } : {}),
          };
          if (tool === 'text') openText(m, d, true);
          else {
            draftRef.current = d;
            finishDraft();
          }
        } else if (draftRef.current) {
          confirmPoint();
        } else {
          draftRef.current = {
            id: newId(),
            type: tool,
            pts: [pt, { ...pt }],
            color,
          };
          downRef.current = pos;
        }
        return;
      }

      if (tool === 'ruler') {
        swallow(e);
        const pt = toPt(m, pos, false);
        if (!pt) return;
        const r = rulerRef.current;
        if (r && !r.done) r.done = true;
        else {
          rulerRef.current = { a: pt, b: { ...pt }, done: false };
          downRef.current = pos;
        }
        return;
      }

      if (tool === 'zoom') {
        swallow(e);
        zoomRef.current = { a: pos, b: pos };
        return;
      }

      // Cursor tools: pick or erase a drawing, otherwise let the chart pan.
      const found = s.locked ? null : hitAll(m, pos);
      if (!found) {
        s.select(null);
        return;
      }
      swallow(e);
      if (tool === 'eraser') {
        s.commit(s.drawings.filter((d) => d.id !== found.d.id));
        return;
      }
      s.select(found.d.id);
      const start = toPt(m, pos, false);
      if (!start) return;
      dragRef.current = {
        id: found.d.id,
        hit: found.hit,
        start,
        orig: found.d.pts.map((p) => ({ ...p })),
      };
      // Snapshot for undo, then move without recording every step.
      s.commit(s.drawings);
    };

    const onMove = (e: PointerEvent) => {
      const m = mapper();
      if (!m) return;
      const pos = local(e);
      const s = stateRef.current;

      const drag = dragRef.current;
      if (drag) {
        const cur = toPt(m, pos, drag.hit.kind === 'handle' && s.magnet);
        if (!cur) return;
        const next = s.drawings.map((d) => {
          if (d.id !== drag.id) return d;
          if (drag.hit.kind === 'handle') {
            const pts = drag.orig.map((p) => ({ ...p }));
            pts[drag.hit.index] = cur;
            return { ...d, pts };
          }
          const dt = cur.t - drag.start.t;
          const dp = cur.p - drag.start.p;
          return {
            ...d,
            pts: drag.orig.map((p) => ({ t: p.t + dt, p: p.p + dp })),
          };
        });
        s.commit(next, false);
        return;
      }

      const d = draftRef.current;
      if (d) {
        const pt = toPt(m, pos);
        if (!pt) return;
        if (pointsNeeded(d.type) === 0) {
          const lastPt = d.pts.at(-1)!;
          const ls = toXY(m, lastPt);
          if (!ls || Math.hypot(ls.x - pos.x, ls.y - pos.y) >= 2) d.pts.push(pt);
        } else d.pts[d.pts.length - 1] = pt;
      }
      const r = rulerRef.current;
      if (r && !r.done) {
        const pt = toPt(m, pos, false);
        if (pt) r.b = pt;
      }
      if (zoomRef.current) zoomRef.current.b = pos;

      // Hover: take the pointer only where we need it, so the chart keeps panning and zooming elsewhere.
      let takes = isDrawingType(s.tool) || s.tool === 'ruler' || s.tool === 'zoom' || d !== null;
      let cursor = takes ? 'crosshair' : '';
      if (!takes && inPlot(m, pos) && !s.locked) {
        const found = hitAll(m, pos);
        if (found) {
          takes = true;
          cursor = s.tool === 'eraser' ? 'pointer' : found.hit.kind === 'handle' ? 'grab' : 'move';
        }
      }
      canvas.style.pointerEvents = takes ? 'auto' : 'none';
      canvas.style.cursor = cursor;
    };

    const onUp = (e: PointerEvent) => {
      const m = mapper();
      const pos = local(e);
      const s = stateRef.current;
      if (dragRef.current) {
        dragRef.current = null;
        return;
      }
      const d = draftRef.current;
      if (d) {
        if (pointsNeeded(d.type) === 0) {
          if (d.pts.length > 1) finishDraft();
          else draftRef.current = null;
        } else if (downRef.current && Math.hypot(downRef.current.x - pos.x, downRef.current.y - pos.y) > 5) {
          downRef.current = null;
          confirmPoint();
        } else downRef.current = null;
      }
      const r = rulerRef.current;
      if (r && !r.done && downRef.current && Math.hypot(downRef.current.x - pos.x, downRef.current.y - pos.y) > 5) {
        r.done = true;
        downRef.current = null;
      }
      const z = zoomRef.current;
      if (z && m) {
        zoomRef.current = null;
        if (Math.abs(z.b.x - z.a.x) > 10) {
          const from = m.logicalAt(Math.min(z.a.x, z.b.x));
          const to = m.logicalAt(Math.max(z.a.x, z.b.x));
          chartRef.current?.timeScale().setVisibleLogicalRange({ from, to });
        }
        s.setTool('cross');
      }
    };

    const onDblClick = (e: MouseEvent) => {
      const m = mapper();
      if (!m) return;
      const found = hitAll(m, local(e));
      if (found?.d.type === 'text' && !stateRef.current.locked) {
        swallow(e);
        openText(m, found.d, false);
      }
    };

    // While the canvas holds the pointer, still let the wheel zoom the chart underneath.
    const onWheel = (e: WheelEvent) => {
      canvas.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      canvas.style.pointerEvents = 'auto';
      if (under && under !== canvas) {
        e.preventDefault();
        under.dispatchEvent(new WheelEvent('wheel', e));
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const s = stateRef.current;
      if (e.key === 'Escape') {
        draftRef.current = null;
        rulerRef.current = null;
        zoomRef.current = null;
        s.select(null);
        if (s.tool !== 'cross' && s.tool !== 'pointer') s.setTool('cross');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId) {
        e.preventDefault();
        s.commit(s.drawings.filter((d) => d.id !== s.selectedId));
        s.select(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        s.undo();
      }
    };

    // ---- rendering ----
    const ctx = canvas.getContext('2d');
    let raf = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth;
      const h = host.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const label = (c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') => {
      c.font = `600 11px ${FONT}`;
      c.textAlign = align;
      c.textBaseline = 'bottom';
      c.fillStyle = color;
      c.fillText(text, x, y - 3);
    };

    const drawOne = (c: CanvasRenderingContext2D, m: Mapper, d: Drawing, selected: boolean) => {
      const sp = screenPts(m, d);
      if (!sp || sp.length === 0) return;
      const [a, b] = sp as [XY, XY | undefined];
      const precision = pricePrecision(d.pts[0]!.p);
      c.strokeStyle = d.color;
      c.fillStyle = d.color;
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.setLineDash([]);
      const line = (p: XY, q: XY) => {
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(q.x, q.y);
        c.stroke();
      };
      switch (d.type) {
        case 'trend':
          if (b) line(a, b);
          break;
        case 'ray':
        case 'extended':
          if (b) {
            const [p, q] = extendLine(a, b, m.w, m.h, d.type === 'extended', true);
            line(p, q);
          }
          break;
        case 'hline':
          line({ x: 0, y: a.y }, { x: m.w, y: a.y });
          label(c, formatPrice(d.pts[0]!.p, precision), m.w - 6, a.y, d.color, 'right');
          break;
        case 'hray':
          line(a, { x: m.w, y: a.y });
          label(c, formatPrice(d.pts[0]!.p, precision), m.w - 6, a.y, d.color, 'right');
          break;
        case 'vline':
          line({ x: a.x, y: 0 }, { x: a.x, y: m.h });
          break;
        case 'crossline':
          line({ x: 0, y: a.y }, { x: m.w, y: a.y });
          line({ x: a.x, y: 0 }, { x: a.x, y: m.h });
          break;
        case 'channel': {
          if (!b) break;
          line(a, b);
          if (d.pts.length < 3) break;
          const off = channelOffset(d.pts);
          const a2 = toXY(m, { t: d.pts[0]!.t, p: d.pts[0]!.p + off });
          const b2 = toXY(m, { t: d.pts[1]!.t, p: d.pts[1]!.p + off });
          if (!a2 || !b2) break;
          line(a2, b2);
          c.fillStyle = withAlpha(d.color, 0.1);
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.lineTo(b2.x, b2.y);
          c.lineTo(a2.x, a2.y);
          c.closePath();
          c.fill();
          c.setLineDash([4, 4]);
          c.lineWidth = 1;
          line({ x: (a.x + a2.x) / 2, y: (a.y + a2.y) / 2 }, { x: (b.x + b2.x) / 2, y: (b.y + b2.y) / 2 });
          break;
        }
        case 'fib': {
          if (!b) break;
          const x0 = Math.min(a.x, b.x);
          const x1 = Math.max(a.x, b.x);
          let prevY: number | null = null;
          FIB_LEVELS.forEach((lvl, i) => {
            const price = fibPrice(d.pts[0]!, d.pts[1]!, lvl);
            const y = m.toY(price);
            if (y === null) return;
            const col = FIB_COLORS[i]!;
            if (prevY !== null) {
              c.fillStyle = withAlpha(col, 0.08);
              c.fillRect(x0, Math.min(prevY, y), x1 - x0, Math.abs(y - prevY));
            }
            prevY = y;
            c.strokeStyle = col;
            c.lineWidth = 1;
            line({ x: x0, y }, { x: x1, y });
            label(c, `${lvl} (${formatPrice(price, precision)})`, x0 + 4, y, col);
          });
          c.strokeStyle = withAlpha(d.color, 0.6);
          c.setLineDash([4, 4]);
          line(a, b);
          break;
        }
        case 'brush':
        case 'highlighter': {
          c.lineWidth = d.type === 'highlighter' ? 14 : 2;
          c.strokeStyle = d.type === 'highlighter' ? withAlpha(d.color, 0.35) : d.color;
          c.beginPath();
          sp.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
          c.stroke();
          break;
        }
        case 'arrow': {
          if (!b) break;
          line(a, b);
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          c.beginPath();
          c.moveTo(b.x, b.y);
          c.lineTo(b.x - 12 * Math.cos(ang - 0.45), b.y - 12 * Math.sin(ang - 0.45));
          c.lineTo(b.x - 12 * Math.cos(ang + 0.45), b.y - 12 * Math.sin(ang + 0.45));
          c.closePath();
          c.fill();
          break;
        }
        case 'arrowUp':
        case 'arrowDown': {
          const dir = d.type === 'arrowUp' ? 1 : -1;
          const tip = a.y + 2 * dir;
          c.beginPath();
          c.moveTo(a.x, tip);
          c.lineTo(a.x + 9, tip + 11 * dir);
          c.lineTo(a.x + 3.5, tip + 11 * dir);
          c.lineTo(a.x + 3.5, tip + 26 * dir);
          c.lineTo(a.x - 3.5, tip + 26 * dir);
          c.lineTo(a.x - 3.5, tip + 11 * dir);
          c.lineTo(a.x - 9, tip + 11 * dir);
          c.closePath();
          c.fill();
          break;
        }
        case 'rect':
          if (!b) break;
          c.fillStyle = withAlpha(d.color, 0.12);
          c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          break;
        case 'ellipse':
          if (!b) break;
          c.beginPath();
          c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
          c.fillStyle = withAlpha(d.color, 0.12);
          c.fill();
          c.stroke();
          break;
        case 'text':
          c.font = `600 ${TEXT_FONT_PX}px ${FONT}`;
          c.textAlign = 'left';
          c.textBaseline = 'alphabetic';
          c.fillText(d.text ?? '', a.x, a.y);
          break;
        case 'emoji':
          c.font = `${EMOJI_PX}px ${FONT}`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(d.text ?? '', a.x, a.y);
          break;
      }
      if (selected && d.type !== 'brush' && d.type !== 'highlighter') {
        c.setLineDash([]);
        c.lineWidth = 2;
        for (const p of sp) {
          c.beginPath();
          c.arc(p.x, p.y, 5, 0, Math.PI * 2);
          c.fillStyle = '#000';
          c.fill();
          c.strokeStyle = d.color;
          c.stroke();
        }
      }
    };

    const drawRuler = (c: CanvasRenderingContext2D, m: Mapper, r: { a: Pt; b: Pt }) => {
      const a = toXY(m, r.a);
      const b = toXY(m, r.b);
      if (!a || !b) return;
      const up = r.b.p >= r.a.p;
      const col = up ? '#2f80ff' : '#ef6049';
      c.fillStyle = withAlpha(col, 0.18);
      c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.setLineDash([]);
      c.beginPath();
      c.moveTo((a.x + b.x) / 2, a.y);
      c.lineTo((a.x + b.x) / 2, b.y);
      c.moveTo(a.x, (a.y + b.y) / 2);
      c.lineTo(b.x, (a.y + b.y) / 2);
      c.stroke();
      const diff = r.b.p - r.a.p;
      const pct = r.a.p === 0 ? 0 : (diff / r.a.p) * 100;
      const bars = Math.round((r.b.t - r.a.t) / stepRef.current);
      const precision = pricePrecision(r.a.p);
      const lines = [
        `${diff >= 0 ? '+' : '−'}${formatPrice(Math.abs(diff), precision)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)`,
        `${Math.abs(bars)} velas, ${durationLabel(r.b.t - r.a.t)}`,
      ];
      c.font = `600 12px ${FONT}`;
      const tw = Math.max(...lines.map((l) => c.measureText(l).width)) + 16;
      const bx = (a.x + b.x) / 2 - tw / 2;
      const by = Math.max(a.y, b.y) + 8;
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(bx, by, tw, 40, 4);
      c.fill();
      c.fillStyle = '#fff';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      lines.forEach((l, i) => c.fillText(l, bx + tw / 2, by + 6 + i * 16));
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      const m = mapper();
      if (!m) return;
      const s = stateRef.current;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, m.w, m.h);
      ctx.clip();
      if (!s.hidden) {
        const editingId = editingRef.current?.drawing.id;
        for (const d of s.drawings) if (d.id !== editingId) drawOne(ctx, m, d, d.id === s.selectedId);
      }
      if (draftRef.current) drawOne(ctx, m, draftRef.current, true);
      if (rulerRef.current) drawRuler(ctx, m, rulerRef.current);
      const z = zoomRef.current;
      if (z) {
        ctx.fillStyle = 'rgba(0,216,232,0.12)';
        ctx.fillRect(Math.min(z.a.x, z.b.x), 0, Math.abs(z.b.x - z.a.x), m.h);
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);

    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    host.addEventListener('dblclick', onDblClick, true);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      host.removeEventListener('dblclick', onDblClick, true);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [hostRef, chartRef, seriesRef, candlesRef, stepRef]);

  const selected = state.selectedId ? state.drawings.find((d) => d.id === state.selectedId) : undefined;

  const saveText = (value: string) => {
    const ed = editingRef.current;
    if (!ed) return;
    setEditing(null);
    const text = value.trim();
    const s = stateRef.current;
    if (ed.isNew) {
      if (!text) return;
      s.commit([...s.drawings, { ...ed.drawing, text }]);
      s.select(ed.drawing.id);
      if (!s.stay) s.setTool('cross');
    } else if (!text) {
      s.commit(s.drawings.filter((d) => d.id !== ed.drawing.id));
    } else if (text !== ed.drawing.text) {
      s.commit(s.drawings.map((d) => (d.id === ed.drawing.id ? { ...d, text } : d)));
    }
  };

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 z-[5]" style={{ pointerEvents: 'none' }} data-testid="drawing-layer" />
      {editing && (
        <input
          autoFocus
          defaultValue={editing.drawing.text ?? ''}
          placeholder="Texto…"
          aria-label="Texto do desenho"
          maxLength={80}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveText(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(null);
          }}
          onBlur={(e) => saveText(e.currentTarget.value)}
          className="absolute z-20 w-48 rounded border border-brand bg-field px-1.5 py-0.5 text-sm font-semibold text-text outline-none"
          style={{ left: editing.x - 6, top: editing.y - TEXT_FONT_PX - 6 }}
        />
      )}
      {selected && !state.locked && !state.hidden && (
        <div
          className="absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-control border border-border bg-field px-1.5 py-1 shadow-xl"
          role="toolbar"
          aria-label="Desenho selecionado"
        >
          {selected.type !== 'fib' &&
            selected.type !== 'emoji' &&
            DRAW_COLORS.map((col) => (
              <button
                key={col}
                type="button"
                aria-label={`Cor ${col}`}
                aria-pressed={selected.color === col}
                onClick={() => state.commit(state.drawings.map((d) => (d.id === selected.id ? { ...d, color: col } : d)))}
                className={cx('size-5 rounded-full border-2', selected.color === col ? 'border-white' : 'border-transparent')}
                style={{ background: col }}
              />
            ))}
          <button
            type="button"
            aria-label="Apagar desenho"
            title="Apagar (Delete)"
            onClick={() => {
              state.commit(state.drawings.filter((d) => d.id !== selected.id));
              state.select(null);
            }}
            className="ml-1 rounded p-1 text-muted hover:bg-surface hover:text-down"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
