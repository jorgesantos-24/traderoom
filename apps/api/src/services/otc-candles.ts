import type pg from 'pg';
import type { Candle, CandleInterval } from '@traderoom/shared';
import type { AssetRepo } from './assets.js';

const INTERVAL_SEC: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

/** Snapshot candle queries running at once; the rest wait without holding a pooled connection. */
const MAX_CONCURRENT_LOADS = 2;
/** Per query: past this the database cancels it and the chart keeps its older copy. */
const LOAD_TIMEOUT_MS = 15_000;
/** Copies are kept this long to stand in when a query fails. */
const STALE_KEEP_MS = 10 * 60_000;

/** Candles built from our own per-second prices (price_snapshots). */
export interface OtcCandleSource {
  /** True for OTC assets (no exchange history; every interval comes from snapshots). */
  has(symbol: string): Promise<boolean>;
  /** Candles of an OTC asset; [] for anything else. `before` (epoch ms): older ones, opening before it. */
  candles(symbol: string, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]>;
  /**
   * Candles of any enabled asset (OTC or market) from price_snapshots, so the chart shows the platform's
   * price, overrides included. Snapshots are kept 7 days; older minutes come from price_candles_1m (rolled
   * up by retention), so a series only comes back short before recording started. [] if not enabled.
   */
  fromSnapshots(symbol: string, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]>;
}

export function createOtcCandleSource(
  pool: pg.Pool,
  assets: Pick<AssetRepo, 'enabled'>,
  opts: { now?: () => number } = {},
): OtcCandleSource {
  const now = opts.now ?? Date.now;
  // Short cache: a chart switch by many users costs one query, and the live tick fills the last candle anyway.
  const cache = new Map<string, { at: number; candles: Candle[] }>();
  const inFlight = new Map<string, Promise<Candle[]>>();
  // These queries read up to days of per-second rows. Unbounded, a burst of chart opens took every pooled
  // connection for minutes and starved orders, balances and login. At most a couple run at once, each capped.
  let running = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT_LOADS) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  async function query<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local statement_timeout = ${LOAD_TIMEOUT_MS}`);
      // Parallel workers ran the small instance out of shared memory ("could not resize shared memory segment").
      await client.query('set local max_parallel_workers_per_gather = 0');
      const { rows } = await client.query<R>(text, values);
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function load(assetId: number, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    const step = INTERVAL_SEC[interval];
    // Latest `limit` buckets, or the `limit` buckets opening before `before`.
    const end = before === undefined ? null : Math.ceil(before / 1000 / step) * step;
    const from = new Date((end === null ? Math.floor(now() / 1000 / step - limit + 1) : end / step - limit) * step * 1000);
    const to = end === null ? 'infinity' : new Date(end * 1000);
    // Buckets aligned to UTC like Binance's (date_bin from the epoch). Each candle opens where the previous
    // one closed (a snapshot is 1 s apart, so "first price in the bucket" left a step between every bar);
    // after a missing bucket (feed down) it opens at its own first price, so downtime still shows as a gap.
    // One extra bucket before `from` is read only to know the first candle's open.
    // Minutes older than the snapshot window come from price_candles_1m (same buckets, already OHLC).
    const rows = await query<{ t: string; o: string; h: string; l: string; c: string }>(
      `with src as (
         select captured_at as ts, price as o, price as h, price as l, price as c
           from price_snapshots
          where asset_id = $1 and captured_at >= $3::timestamptz - make_interval(secs => $2) and captured_at < $4::timestamptz
         union all
         select t, o, h, l, c
           from price_candles_1m
          where asset_id = $1 and t >= $3::timestamptz - make_interval(secs => $2) and t < $4::timestamptz
       ), k as (
         select b,
                (array_agg(o order by ts asc))[1] as first,
                max(h) as hi,
                min(l) as lo,
                (array_agg(c order by ts desc))[1] as c
           from (select date_bin(make_interval(secs => $2), ts, timestamptz 'epoch') as b, o, h, l, c, ts from src) s
          group by b
       ), o as (
         select b, hi, lo, c,
                case when lag(b) over w = b - make_interval(secs => $2) then lag(c) over w else first end as o
           from k
         window w as (order by b)
       )
       select (extract(epoch from b) * 1000)::bigint::text as t,
              o::text as o,
              greatest(hi, o)::text as h,
              least(lo, o)::text as l,
              c::text as c
         from o
        where b >= $3::timestamptz
        order by b`,
      [assetId, step, from, to],
    );
    return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: 0 }));
  }

  function cached(assetId: number, symbol: string, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}:${limit}:${before ?? ''}`;
    // Older pages do not change (only the newest one can still be filling in).
    // The live tick fills the newest candle on the client, so a longer copy only delays bars that already closed.
    const step = INTERVAL_SEC[interval];
    const ttl = before !== undefined ? 60_000 : step >= 3600 ? 120_000 : step >= 300 ? 30_000 : 5_000;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.candles);
    let p = inFlight.get(key);
    if (!p) {
      p = limited(() => load(assetId, interval, limit, before))
        .then((candles) => {
          for (const [k, v] of cache) if (now() - v.at >= STALE_KEEP_MS) cache.delete(k);
          cache.set(key, { at: now(), candles });
          return candles;
        })
        .catch((err: unknown) => {
          // A slow or failed query: an older copy beats an error on the chart.
          if (hit) return hit.candles;
          throw err;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  }

  return {
    async has(symbol) {
      return (await assets.enabled()).bySymbol.get(symbol)?.kind === 'otc';
    },
    async candles(symbol, interval, limit, before) {
      const asset = (await assets.enabled()).bySymbol.get(symbol);
      if (!asset || asset.kind !== 'otc') return [];
      return cached(asset.id, symbol, interval, limit, before);
    },
    async fromSnapshots(symbol, interval, limit, before) {
      const asset = (await assets.enabled()).bySymbol.get(symbol);
      if (!asset) return [];
      return cached(asset.id, symbol, interval, limit, before);
    },
  };
}
