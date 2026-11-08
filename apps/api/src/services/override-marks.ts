import type pg from 'pg';
import { CANDLE_INTERVAL_MS, type Candle, type CandleInterval, type CandleMark } from '@traderoom/shared';

/** Marks on candles whose close the platform set. Overrides are never deleted, so the mark outlives the override. */
export interface OverrideMarkSource {
  marks(symbol: string, interval: CandleInterval, candles: readonly Candle[]): Promise<CandleMark[]>;
}

export interface OverrideRow {
  candleOpenMs: number;
  candleCloseMs: number;
  targetPrice: number;
}

/**
 * Puts each override on the candle (of the requested interval) holding its close, the moment the
 * platform set. Several overrides in one candle (long intervals) give one mark: the latest close.
 * An override with no candle in the list (a gap in the feed) gives no mark.
 */
export function toMarks(rows: readonly OverrideRow[], candles: readonly Candle[], interval: CandleInterval): CandleMark[] {
  const step = CANDLE_INTERVAL_MS[interval];
  const byOpen = new Map(candles.map((c) => [c.t, c]));
  const latest = new Map<number, OverrideRow>();
  for (const r of rows) {
    const openMs = Math.floor((r.candleCloseMs - 1) / step) * step;
    const prev = latest.get(openMs);
    if (!prev || r.candleCloseMs > prev.candleCloseMs) latest.set(openMs, r);
  }
  const marks: CandleMark[] = [];
  for (const [openMs, r] of latest) {
    const candle = byOpen.get(openMs);
    if (!candle) continue;
    const direction = r.targetPrice > candle.o ? 'up' : r.targetPrice < candle.o ? 'down' : 'flat';
    marks.push({ openMs, targetPrice: r.targetPrice, direction });
  }
  return marks.sort((a, b) => a.openMs - b.openMs);
}

export function createOverrideMarkSource(pool: pg.Pool): OverrideMarkSource {
  return {
    async marks(symbol, interval, candles) {
      const first = candles[0];
      const last = candles.at(-1);
      if (!first || !last) return [];
      // Ended overrides count. Left out: one released before its candle closed, or whose publish failed
      // (ended_at set right away): the close was not the target, so the candle is not marked. A scheduled
      // override has no target until the ws resolves it in its candle: no mark before that.
      const { rows } = await pool.query<{ o: string; c: string; p: string }>(
        `select o.candle_open_ms::text as o, o.candle_close_ms::text as c, o.target_price::text as p
           from otc_overrides o join assets a on a.id = o.asset_id
          where a.symbol = $1 and o.candle_open_ms >= $2 and o.candle_open_ms < $3 and o.target_price is not null
            and (o.ended_at is null or o.ended_at >= to_timestamp(o.candle_close_ms / 1000.0))`,
        [symbol, first.t, last.t + CANDLE_INTERVAL_MS[interval]],
      );
      return toMarks(
        rows.map((r) => ({ candleOpenMs: Number(r.o), candleCloseMs: Number(r.c), targetPrice: Number(r.p) })),
        candles,
        interval,
      );
    },
  };
}
