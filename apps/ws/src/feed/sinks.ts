import type pg from 'pg';
import type { Redis } from 'ioredis';
import { PRICE_TTL_MS, RedisKeys, type PriceRecord } from '@traderoom/shared';
import type { FeedAsset, Tick } from './types.js';

export interface SnapshotRow {
  assetId: number;
  price: string;
  /** Real provider price, only while an override changes `price`. */
  realPrice?: string | null;
  capturedAt: Date;
}

/** Where the relay sends its output. Real implementations below; tests pass fakes. */
export interface RelaySinks {
  /** One call per 200 ms window with the newest tick of each changed symbol. */
  writePrices(ticks: readonly Tick[]): Promise<void>;
  /** One call per second with the current price of every fresh symbol. */
  writeSnapshots(rows: readonly SnapshotRow[]): Promise<void>;
  loadAssets(): Promise<FeedAsset[]>;
  /** Newest stored price of an asset (OTC restarts continue from it). Optional: without it OTC starts fresh. */
  lastPrice?(assetId: number): Promise<number | null>;
  /** Raw `otc:override` value. Optional: without it no override is ever applied. */
  readOverride?(): Promise<string | null>;
}

export function toPriceRecord(t: Tick): PriceRecord {
  const rec: PriceRecord = { p: t.price, ts: t.ts, rt: t.recvMs, src: t.provider };
  if (t.ov) rec.ov = t.ov;
  return rec;
}

export async function writePricesToRedis(redis: Redis, ticks: readonly Tick[]): Promise<void> {
  if (ticks.length === 0) return;
  const pipe = redis.pipeline();
  let newest = 0;
  for (const t of ticks) {
    pipe.set(RedisKeys.price(t.symbol), JSON.stringify(toPriceRecord(t)), 'PX', PRICE_TTL_MS);
    if (t.recvMs > newest) newest = t.recvMs;
  }
  pipe.set(RedisKeys.feedLastTickMs, String(newest));
  const results = await pipe.exec();
  const failed = results?.find(([err]) => err !== null);
  if (failed?.[0]) throw failed[0];
}

export async function insertSnapshots(pool: pg.Pool, rows: readonly SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  await pool.query(
    `insert into price_snapshots (asset_id, price, real_price, captured_at)
     select * from unnest($1::int[], $2::numeric[], $3::numeric[], $4::timestamptz[])`,
    [rows.map((r) => r.assetId), rows.map((r) => r.price), rows.map((r) => r.realPrice ?? null), rows.map((r) => r.capturedAt)],
  );
}

const SYMBOL = /^[A-Z0-9]{2,20}$/;
const STREAM = /^[a-z0-9]+@(bookTicker|trade|aggTrade)$/;

export interface LoadedAssets {
  assets: FeedAsset[];
  /** Rows skipped because symbol or stream is malformed. */
  invalid: Array<{ id: number; symbol: string; binanceStream: string }>;
}

export async function loadEnabledAssets(pool: pg.Pool): Promise<LoadedAssets> {
  const { rows } = await pool.query<{
    id: number;
    symbol: string;
    binance_stream: string | null;
    kind: string;
    otc_start_price: string | null;
    otc_vol_pct_hour: string | null;
    otc_decimals: number | null;
    otc_drift_pct_hour: string;
  }>(
    `select id, symbol, binance_stream, kind, otc_start_price::text, otc_vol_pct_hour::text, otc_decimals, otc_drift_pct_hour::text
       from assets where enabled order by sort, id`,
  );
  const out: LoadedAssets = { assets: [], invalid: [] };
  for (const r of rows) {
    if (r.kind === 'otc') {
      const otc = {
        startPrice: Number(r.otc_start_price),
        volPctHour: Number(r.otc_vol_pct_hour),
        decimals: Number(r.otc_decimals),
        driftPctHour: Number(r.otc_drift_pct_hour),
      };
      const ok = SYMBOL.test(r.symbol) && otc.startPrice > 0 && otc.volPctHour > 0 && Number.isInteger(otc.decimals);
      (ok ? out.assets : out.invalid).push({ id: r.id, symbol: r.symbol, binanceStream: '', ...(ok ? { otc } : {}) });
      continue;
    }
    const a = { id: r.id, symbol: r.symbol, binanceStream: r.binance_stream ?? '' };
    // The stream must belong to the same symbol, otherwise prices would land on the wrong asset.
    const ok = SYMBOL.test(a.symbol) && STREAM.test(a.binanceStream) && a.binanceStream.startsWith(`${a.symbol.toLowerCase()}@`);
    (ok ? out.assets : out.invalid).push(a);
  }
  return out;
}

export async function lastPrice(pool: pg.Pool, assetId: number): Promise<number | null> {
  const { rows } = await pool.query<{ price: string }>(
    'select price::text as price from price_snapshots where asset_id = $1 order by captured_at desc limit 1',
    [assetId],
  );
  return rows[0] ? Number(rows[0].price) : null;
}
