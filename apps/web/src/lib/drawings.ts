/** Chart drawings: shapes the trader draws over the candles, stored per asset in this browser. */

/** A point in chart space: time (ms, may fall between or after candles) and price. */
export interface Pt {
  t: number;
  p: number;
}

export type DrawingType =
  | 'trend'
  | 'ray'
  | 'extended'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'crossline'
  | 'channel'
  | 'fib'
  | 'brush'
  | 'highlighter'
  | 'arrow'
  | 'arrowUp'
  | 'arrowDown'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'emoji';

export interface Drawing {
  id: string;
  type: DrawingType;
  pts: Pt[];
  color: string;
  /** Text or emoji for those types. */
  text?: string;
}

/** Pointer modes that don't create a drawing. */
export type CursorTool = 'cross' | 'pointer' | 'eraser';
export type Tool = CursorTool | DrawingType | 'ruler' | 'zoom';

export const TOOL_LABEL: Record<Tool, string> = {
  cross: 'Cruz',
  pointer: 'Seta',
  eraser: 'Borracha',
  trend: 'Linha de Tendência',
  ray: 'Raio',
  extended: 'Linha Estendida',
  hline: 'Linha Horizontal',
  hray: 'Raio Horizontal',
  vline: 'Linha Vertical',
  crossline: 'Linha Cruzada',
  channel: 'Canal Paralelo',
  fib: 'Retração de Fibonacci',
  brush: 'Pincel',
  highlighter: 'Marcatexto',
  arrow: 'Seta',
  arrowUp: 'Seta para Cima',
  arrowDown: 'Seta para Baixo',
  rect: 'Retângulo',
  ellipse: 'Elipse',
  text: 'Texto',
  emoji: 'Emoji',
  ruler: 'Régua',
  zoom: 'Zoom de área',
};

/** How many clicks place each drawing (0 = freehand stroke). */
export function pointsNeeded(type: DrawingType): number {
  switch (type) {
    case 'hline':
    case 'hray':
    case 'vline':
    case 'crossline':
    case 'arrowUp':
    case 'arrowDown':
    case 'text':
    case 'emoji':
      return 1;
    case 'channel':
      return 3;
    case 'brush':
    case 'highlighter':
      return 0;
    default:
      return 2;
  }
}

export const isDrawingType = (t: Tool): t is DrawingType => !['cross', 'pointer', 'eraser', 'ruler', 'zoom'].includes(t);

export const DRAW_COLORS = ['#00d8e8', '#2f80ff', '#4fa65b', '#ef6049', '#f5a524', '#b37feb', '#ffffff'] as const;

export function defaultColor(type: DrawingType): string {
  if (type === 'arrowUp') return '#4fa65b';
  if (type === 'arrowDown') return '#ef6049';
  if (type === 'highlighter') return '#f5a524';
  if (type === 'text') return '#ffffff';
  return '#00d8e8';
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_COLORS = ['#89898d', '#ef6049', '#f5a524', '#4fa65b', '#00d8e8', '#2f80ff', '#89898d'] as const;

/** Price of a Fibonacci level between the two anchor points (level 0 at the second point, as on TradingView). */
export const fibPrice = (a: Pt, b: Pt, level: number): number => b.p + (a.p - b.p) * level;

export const EMOJIS = ['🚀', '🔥', '💰', '📈', '📉', '👍', '👎', '⭐', '⚠️', '✅', '❌', '🎯', '💎', '🐂', '🐻', '😀'] as const;

// ---- geometry (screen space) ----

export interface XY {
  x: number;
  y: number;
}

export function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/**
 * The visible part of the line through a and b, extended to the box edges
 * (`back`/`forward` choose which ends extend). Returns the two ends to draw.
 */
export function extendLine(a: XY, b: XY, width: number, height: number, back: boolean, forward: boolean): [XY, XY] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a, b];
  const far = 4 * (width + height);
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  return [back ? { x: a.x - ux * far, y: a.y - uy * far } : a, forward ? { x: b.x + ux * far, y: b.y + uy * far } : b];
}

/** Second rail of a parallel channel: the base line shifted (in price) so it passes through the third point. */
export function channelOffset(pts: readonly Pt[]): number {
  const [a, b, c] = pts;
  if (!a || !b || !c) return 0;
  const onLine = b.t === a.t ? a.p : a.p + ((b.p - a.p) * (c.t - a.t)) / (b.t - a.t);
  return c.p - onLine;
}

export const HIT_PX = 6;
export const HANDLE_PX = 7;
export const TEXT_FONT_PX = 14;
export const EMOJI_PX = 28;

export type Hit = { kind: 'handle'; index: number } | { kind: 'body' };

/**
 * What the pointer is over on this drawing. `sp` are the drawing's points in screen space,
 * `w`/`h` the plot size. Text and emoji use an approximate box.
 */
export function hitTest(d: Drawing, sp: readonly XY[], pos: XY, w: number, h: number): Hit | null {
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i]!;
    if (d.type !== 'brush' && d.type !== 'highlighter' && Math.hypot(pos.x - s.x, pos.y - s.y) <= HANDLE_PX)
      return { kind: 'handle', index: i };
  }
  const [a, b] = sp;
  if (!a) return null;
  const near = (p: XY, q: XY, tol = HIT_PX) => distToSegment(pos, p, q) <= tol;
  switch (d.type) {
    case 'trend':
    case 'arrow':
      return b && near(a, b) ? { kind: 'body' } : null;
    case 'ray':
    case 'extended': {
      if (!b) return null;
      const [p, q] = extendLine(a, b, w, h, d.type === 'extended', true);
      return near(p, q) ? { kind: 'body' } : null;
    }
    case 'hline':
      return Math.abs(pos.y - a.y) <= HIT_PX ? { kind: 'body' } : null;
    case 'hray':
      return pos.x >= a.x - HIT_PX && Math.abs(pos.y - a.y) <= HIT_PX ? { kind: 'body' } : null;
    case 'vline':
      return Math.abs(pos.x - a.x) <= HIT_PX ? { kind: 'body' } : null;
    case 'crossline':
      return Math.abs(pos.y - a.y) <= HIT_PX || Math.abs(pos.x - a.x) <= HIT_PX ? { kind: 'body' } : null;
    case 'channel': {
      const c = sp[2];
      if (!b) return null;
      if (near(a, b)) return { kind: 'body' };
      if (!c) return null;
      // The second rail is the base shifted vertically by the third point's offset from the base.
      const off = c.y - (b.x === a.x ? a.y : a.y + ((b.y - a.y) * (c.x - a.x)) / (b.x - a.x));
      return near({ x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }) ? { kind: 'body' } : null;
    }
    case 'fib':
    case 'rect': {
      if (!b) return null;
      const x0 = Math.min(a.x, b.x) - HIT_PX;
      const x1 = Math.max(a.x, b.x) + HIT_PX;
      const y0 = Math.min(a.y, b.y) - HIT_PX;
      const y1 = Math.max(a.y, b.y) + HIT_PX;
      return pos.x >= x0 && pos.x <= x1 && pos.y >= y0 && pos.y <= y1 ? { kind: 'body' } : null;
    }
    case 'ellipse': {
      if (!b) return null;
      const rx = Math.abs(b.x - a.x) / 2 + HIT_PX;
      const ry = Math.abs(b.y - a.y) / 2 + HIT_PX;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      return ((pos.x - cx) / rx) ** 2 + ((pos.y - cy) / ry) ** 2 <= 1 ? { kind: 'body' } : null;
    }
    case 'brush':
    case 'highlighter': {
      const tol = d.type === 'highlighter' ? 10 : HIT_PX;
      for (let i = 1; i < sp.length; i++) if (near(sp[i - 1]!, sp[i]!, tol)) return { kind: 'body' };
      return null;
    }
    case 'arrowUp':
    case 'arrowDown': {
      const dy = d.type === 'arrowUp' ? 14 : -14;
      return Math.abs(pos.x - a.x) <= 10 && Math.abs(pos.y - (a.y + dy)) <= 16 ? { kind: 'body' } : null;
    }
    case 'text': {
      const width = Math.max(1, (d.text ?? '').length) * TEXT_FONT_PX * 0.6;
      return pos.x >= a.x - 4 && pos.x <= a.x + width + 4 && pos.y >= a.y - TEXT_FONT_PX - 4 && pos.y <= a.y + 6 ? { kind: 'body' } : null;
    }
    case 'emoji':
      return Math.abs(pos.x - a.x) <= EMOJI_PX / 2 && Math.abs(pos.y - a.y) <= EMOJI_PX / 2 ? { kind: 'body' } : null;
  }
}

// ---- storage ----

const KEY = (symbol: string) => `kyden.drawings.v1.${symbol}`;

export function loadDrawings(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(KEY(symbol));
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isDrawing) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(symbol: string, list: readonly Drawing[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY(symbol));
    else localStorage.setItem(KEY(symbol), JSON.stringify(list));
  } catch {
    // storage blocked or full: drawings just won't survive a reload
  }
}

function isDrawing(v: unknown): v is Drawing {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Drawing;
  return (
    typeof d.id === 'string' &&
    typeof d.type === 'string' &&
    typeof d.color === 'string' &&
    Array.isArray(d.pts) &&
    d.pts.every((p) => typeof p?.t === 'number' && typeof p?.p === 'number' && Number.isFinite(p.t) && Number.isFinite(p.p))
  );
}
