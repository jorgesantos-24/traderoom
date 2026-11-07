import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelOffset,
  distToSegment,
  extendLine,
  fibPrice,
  hitTest,
  isDrawingType,
  loadDrawings,
  pointsNeeded,
  saveDrawings,
  type Drawing,
} from './drawings';

const d = (over: Partial<Drawing>): Drawing => ({ id: 'x', type: 'trend', pts: [], color: '#fff', ...over });

describe('geometry', () => {
  it('measures the distance to a segment, clamped to its ends', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('extends a line forward only, or both ways', () => {
    const [p, q] = extendLine({ x: 0, y: 0 }, { x: 10, y: 0 }, 100, 100, false, true);
    expect(p).toEqual({ x: 0, y: 0 });
    expect(q.x).toBeGreaterThan(100);
    const [r] = extendLine({ x: 0, y: 0 }, { x: 10, y: 0 }, 100, 100, true, true);
    expect(r.x).toBeLessThan(-100);
  });

  it('puts the channel rail through the third point', () => {
    const pts = [
      { t: 0, p: 100 },
      { t: 10, p: 110 },
      { t: 5, p: 120 },
    ];
    // Base at t=5 is 105, so the rail sits 15 above it.
    expect(channelOffset(pts)).toBe(15);
  });

  it('places Fibonacci levels with 0 at the second point and 1 at the first', () => {
    const a = { t: 0, p: 200 };
    const b = { t: 1, p: 100 };
    expect(fibPrice(a, b, 0)).toBe(100);
    expect(fibPrice(a, b, 1)).toBe(200);
    expect(fibPrice(a, b, 0.5)).toBe(150);
  });
});

describe('hitTest', () => {
  it('prefers a handle over the body', () => {
    const sp = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(hitTest(d({ type: 'trend' }), sp, { x: 2, y: 1 }, 500, 500)).toEqual({ kind: 'handle', index: 0 });
    expect(hitTest(d({ type: 'trend' }), sp, { x: 50, y: 52 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'trend' }), sp, { x: 50, y: 80 }, 500, 500)).toBeNull();
  });

  it('hits a horizontal line anywhere along the plot and a ray only to its right', () => {
    const sp = [{ x: 200, y: 50 }];
    expect(hitTest(d({ type: 'hline' }), sp, { x: 10, y: 53 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'hray' }), sp, { x: 10, y: 53 }, 500, 500)).toBeNull();
    expect(hitTest(d({ type: 'hray' }), sp, { x: 400, y: 53 }, 500, 500)).toEqual({ kind: 'body' });
  });

  it('hits inside a rectangle and an ellipse', () => {
    const sp = [
      { x: 100, y: 100 },
      { x: 200, y: 160 },
    ];
    expect(hitTest(d({ type: 'rect' }), sp, { x: 150, y: 130 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'ellipse' }), sp, { x: 150, y: 130 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'ellipse' }), sp, { x: 108, y: 104 }, 500, 500)).toBeNull();
  });

  it('hits a brush stroke near any of its segments, with no handles', () => {
    const sp = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    expect(hitTest(d({ type: 'brush' }), sp, { x: 0, y: 0 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'brush' }), sp, { x: 53, y: 30 }, 500, 500)).toEqual({ kind: 'body' });
    expect(hitTest(d({ type: 'brush' }), sp, { x: 25, y: 25 }, 500, 500)).toBeNull();
  });
});

describe('tools', () => {
  it('knows how many clicks each drawing takes', () => {
    expect(pointsNeeded('hline')).toBe(1);
    expect(pointsNeeded('trend')).toBe(2);
    expect(pointsNeeded('channel')).toBe(3);
    expect(pointsNeeded('brush')).toBe(0);
  });

  it('tells drawing tools from cursor, ruler and zoom', () => {
    expect(isDrawingType('arrow')).toBe(true);
    expect(isDrawingType('pointer')).toBe(false);
    expect(isDrawingType('ruler')).toBe(false);
  });
});

describe('storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips drawings per asset and drops malformed entries', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const good = d({ id: 'a', pts: [{ t: 1, p: 2 }] });
    saveDrawings('BTCUSDT', [good]);
    expect(loadDrawings('BTCUSDT')).toEqual([good]);
    expect(loadDrawings('ETHUSDT')).toEqual([]);
    store.set('kyden.drawings.v1.ETHUSDT', JSON.stringify([good, { id: 1 }, { ...good, pts: [{ t: 'x', p: 1 }] }]));
    expect(loadDrawings('ETHUSDT')).toEqual([good]);
    saveDrawings('BTCUSDT', []);
    expect(store.has('kyden.drawings.v1.BTCUSDT')).toBe(false);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });
    expect(loadDrawings('BTCUSDT')).toEqual([]);
    expect(() => saveDrawings('BTCUSDT', [d({})])).not.toThrow();
  });
});
