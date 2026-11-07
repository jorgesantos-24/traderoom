import type { Mapper } from '../lib/chart-mapper';
import { formatPrice, pricePrecision } from '../lib/format';
import { INDICATOR_BY_TYPE, type IndicatorConfig } from '../lib/indicators';
import { lineAt, patternSettings, visiblePatterns, type Line, type Pattern, type Pt } from '../lib/patterns';
import { FONT, rgba } from './draw-utils';

/** Chart patterns over the candles: outline, filled body, name tag and price target. */
export function drawPatterns(c: CanvasRenderingContext2D, m: Mapper, cfg: IndicatorConfig, all: Pattern[]) {
  const def = INDICATOR_BY_TYPE.get('patterns')!;
  const color = (key: string) => cfg.colors[key] ?? def.outputs.find((o) => o.key === key)?.color ?? '#2962ff';
  const s = patternSettings(cfg.params);
  const X = (i: number) => m.toX(m.candles[Math.min(i, m.lastIdx)]!.t) + Math.max(0, i - m.lastIdx) * m.spacing;
  const xy = (p: Pt) => {
    const y = m.toY(p.p);
    return y === null ? null : { x: X(p.i), y };
  };
  const precision = pricePrecision(m.candles[m.lastIdx]!.c);

  const path = (pts: Pt[]) => {
    const list = pts.map(xy);
    if (list.some((q) => q === null)) return false;
    c.beginPath();
    list.forEach((q, i) => (i === 0 ? c.moveTo(q!.x, q!.y) : c.lineTo(q!.x, q!.y)));
    return true;
  };
  const stroke = (col: string, width: number, dash: number[] = []) => {
    c.setLineDash(dash);
    c.lineWidth = width;
    c.strokeStyle = col;
    c.stroke();
    c.setLineDash([]);
  };
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const tag = (text: string, x: number, y: number, bg: string, place: 'above' | 'below') => {
    c.font = `600 11px ${FONT}`;
    const w = c.measureText(text).width + 12;
    const h = 18;
    // Keep the tag on screen when the pattern starts or ends outside the visible area.
    x = Math.max(w / 2 + 2, Math.min(m.w - w / 2 - 2, x));
    // A target beyond the visible prices stays readable, pinned to the top (below the legend) or bottom edge.
    const minTop = 32;
    const maxTop = m.h - h - 2;
    const pin = (v: number) => Math.max(minTop, Math.min(maxTop, v));
    let top = pin(place === 'above' ? y - h - 6 : y + 6);
    // Step away from tags already drawn so names never sit on top of each other (away from the edge it is pinned to).
    let step = place === 'above' ? -(h + 3) : h + 3;
    if (top + step < minTop || top + step > maxTop) step = -step;
    const hit = () => placed.some((r) => x - w / 2 < r.x + r.w && r.x < x + w / 2 && top < r.y + r.h && r.y < top + h);
    for (let i = 0; i < 6 && hit(); i++) top = pin(top + step);
    placed.push({ x: x - w / 2, y: top, w, h });
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(x - w / 2, top, w, h, 3);
    c.fill();
    c.fillStyle = textOn(bg);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, top + h / 2 + 0.5);
  };
  const lineFill = (u: Line, l: Line, fill: string) => {
    if (path([u.a, u.b, l.b, l.a])) {
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    }
  };

  for (const p of visiblePatterns(all, s.show)) {
    // Fully scrolled out of view (target leg included): nothing to draw, and no pinned tags.
    if (X(p.breakout.i) + 10 * m.spacing < 0 || X(p.start) > m.w) continue;
    const col = color(p.family);
    const end: Pt = p.breakout;
    // Still forming (no breakout yet): dashed outline, lighter fill, no target.
    const forming = p.status === 'forming';
    const dash = forming ? [5, 4] : [];
    const fillA = forming ? 0.07 : 0.13;

    if (p.upper && p.lower) {
      // Wedges, triangles, rectangles, flags and pennants: two boundaries with the body filled.
      lineFill(p.upper, p.lower, rgba(col, fillA));
      if (path([p.upper.a, p.upper.b])) stroke(col, 1.5, dash);
      if (path([p.lower.a, p.lower.b])) stroke(col, 1.5, dash);
      const isFlag = p.family === 'flag' || p.family === 'pennant';
      if (path(isFlag ? p.points.slice(0, 2) : p.points)) stroke(rgba(col, isFlag ? 0.9 : 0.6), isFlag ? 2 : 1, dash);
    } else if (p.cup) {
      const L = xy(p.cup.left);
      const B = xy(p.cup.bottom);
      const R = xy(p.cup.right);
      if (L && B && R) {
        // Quadratic curve through the bottom: control point mirrored past it.
        const cx = 2 * B.x - (L.x + R.x) / 2;
        const cy = 2 * B.y - (L.y + R.y) / 2;
        c.beginPath();
        c.moveTo(L.x, L.y);
        c.quadraticCurveTo(cx, cy, R.x, R.y);
        c.closePath();
        c.fillStyle = rgba(col, 0.13);
        c.fill();
        c.beginPath();
        c.moveTo(L.x, L.y);
        c.quadraticCurveTo(cx, cy, R.x, R.y);
        stroke(col, 1.5);
      }
      if (path([...p.points, end])) stroke(col, 1.5);
    } else {
      // Tops, bottoms, head and shoulders: the swing outline closed on the neckline.
      const neck = p.neckline!;
      const body = [
        ...p.points,
        { i: p.points.at(-1)!.i, p: lineAt(neck, p.points.at(-1)!.i) },
        { i: p.points[0]!.i, p: lineAt(neck, p.points[0]!.i) },
      ];
      if (path(body)) {
        c.closePath();
        c.fillStyle = rgba(col, fillA);
        c.fill();
      }
      if (path(forming ? p.points : [...p.points, end])) stroke(col, 1.5, dash);
    }
    if (p.neckline && path([p.neckline.a, p.neckline.b])) stroke(col, 1, [5, 4]);

    // Name tag: under bullish patterns, over bearish ones, centred on the pattern.
    const prices = [...p.points.map((q) => q.p), ...(p.cup ? [p.cup.bottom.p] : [])];
    const edge = p.dir === 1 ? Math.min(...prices) : Math.max(...prices);
    const ye = m.toY(edge);
    if (ye !== null)
      tag(
        `${p.dir === 1 ? '▲' : '▼'} ${forming ? `${p.name} (em formação)` : p.name}`,
        (X(p.start) + X(end.i)) / 2,
        ye,
        forming ? rgba(col, 0.7) : col,
        p.dir === 1 ? 'below' : 'above',
      );

    // Target: dotted line from the breakout to the measured move, and its tag.
    if (s.targets && !forming) {
      const b = xy(end);
      const yt = m.toY(p.target);
      if (b && yt !== null) {
        const xt = b.x + 10 * m.spacing;
        c.beginPath();
        c.moveTo(b.x, b.y);
        c.lineTo(b.x, yt);
        c.lineTo(xt, yt);
        stroke(rgba(col, 0.9), 1, [2, 3]);
        const reached = p.status === 'reached';
        tag(
          `${reached ? 'Alvo ✓' : 'Alvo'} ${formatPrice(p.target, precision)}`,
          xt,
          yt,
          reached ? rgba(col, 0.55) : col,
          p.dir === 1 ? 'above' : 'below',
        );
      }
    }
  }
}

/** Dark text on light tag colors (yellow, pink), white on the rest. */
function textOn(bg: string): string {
  const m = bg.match(/rgba?\((\d+),(\d+),(\d+)/);
  let r: number, g: number, b: number;
  if (m) [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    const n = parseInt(bg.replace('#', '').slice(0, 6), 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#131722' : '#ffffff';
}
