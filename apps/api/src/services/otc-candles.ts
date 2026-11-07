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

/** Candles of OTC assets, built from our own per-second prices (there is no exchange to ask). */
export interface OtcCandleSource {
  has(symbol: string): Promise<boolean>;
  candles(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]>;
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
    // Buckets aligned to UTC like Binance's (date_bin from the epoch). Open/close are the first/last price in the bucket.
    const { rows } = await pool.query<{ t: string; o: string; h: string; l: string; c: string }>(
      `select (extract(epoch from b) * 1000)::bigint::text as t,
              (array_agg(price order by captured_at asc))[1]::text as o,
              max(price)::text as h,
              min(price)::text as l,
              (array_agg(price order by captured_at desc))[1]::text as c
         from (select date_bin(make_interval(secs => $2), captured_at, timestamptz 'epoch') as b, price, captured_at
                 from price_snapshots
                where asset_id = $1 and captured_at >= $3) s
        group by b
        order by b`,
      [assetId, step, from],
    );
    return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: 0 }));
  }

  return {
    async has(symbol) {
      return (await assets.enabled()).bySymbol.get(symbol)?.kind === 'otc';
    },
    async candles(symbol, interval, limit) {
      const asset = (await assets.enabled()).bySymbol.get(symbol);
      if (!asset || asset.kind !== 'otc') return [];
      const key = `${symbol}:${interval}:${limit}`;
      const ttl = INTERVAL_SEC[interval] >= 3600 ? 30_000 : 3_000;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return hit.candles;
      let p = inFlight.get(key);
      if (!p) {
        p = load(asset.id, interval, limit)
          .then((candles) => {
            cache.set(key, { at: now(), candles });
            return candles;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      return p;
    },
  };
}
