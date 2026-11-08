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

/** Candles built from our own per-second prices (price_snapshots). */
export interface OtcCandleSource {
  /** True for OTC assets (no exchange history; every interval comes from snapshots). */
  has(symbol: string): Promise<boolean>;
  /** Candles of an OTC asset; [] for anything else. */
  candles(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
  /**
   * Candles of any enabled asset (OTC or market) from price_snapshots, so the chart shows the platform's
   * price, overrides included. Snapshots are kept 7 days, so long series come back short. [] if not enabled.
   */
  fromSnapshots(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
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

  async function load(assetId: number, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const step = INTERVAL_SEC[interval];
    const from = new Date(Math.floor(now() / 1000 / step - limit + 1) * step * 1000);
    // Buckets aligned to UTC like Binance's (date_bin from the epoch). Each candle opens where the previous
    // one closed (a snapshot is 1 s apart, so "first price in the bucket" left a step between every bar);
    // after a missing bucket (feed down) it opens at its own first price, so downtime still shows as a gap.
    // One extra bucket before `from` is read only to know the first candle's open.
    const { rows } = await pool.query<{ t: string; o: string; h: string; l: string; c: string }>(
      `with k as (
         select b,
                (array_agg(price order by captured_at asc))[1] as first,
                max(price) as hi,
                min(price) as lo,
                (array_agg(price order by captured_at desc))[1] as c
           from (select date_bin(make_interval(secs => $2), captured_at, timestamptz 'epoch') as b, price, captured_at
                   from price_snapshots
                  where asset_id = $1 and captured_at >= $3::timestamptz - make_interval(secs => $2)) s
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
      [assetId, step, from],
    );
    return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: 0 }));
  }

  function cached(assetId: number, symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}:${limit}`;
    const ttl = INTERVAL_SEC[interval] >= 3600 ? 30_000 : 3_000;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.candles);
    let p = inFlight.get(key);
    if (!p) {
      p = load(assetId, interval, limit)
        .then((candles) => {
          cache.set(key, { at: now(), candles });
          return candles;
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
    async candles(symbol, interval, limit) {
      const asset = (await assets.enabled()).bySymbol.get(symbol);
      if (!asset || asset.kind !== 'otc') return [];
      return cached(asset.id, symbol, interval, limit);
    },
    async fromSnapshots(symbol, interval, limit) {
      const asset = (await assets.enabled()).bySymbol.get(symbol);
      if (!asset) return [];
      return cached(asset.id, symbol, interval, limit);
    },
  };
}
