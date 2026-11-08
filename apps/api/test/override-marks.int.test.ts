// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Candle, CandlesResponse } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { createOverrideMarkSource } from '../src/services/override-marks.js';
import { emptyCandles, FAKE_SID, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const RUN = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
const SYMBOL = `ZZMK${RUN}`;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
// Ten 1m candles from T0, all opening at 100.
const CANDLES: Candle[] = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * MIN, o: 100, h: 101, l: 99, c: 100, v: 0 }));

let pool: pg.Pool;
let app: FastifyInstance;
let assetId: number;
let userId: string;

async function override(openMs: number, target: number, endedAt: Date | null, active = false): Promise<void> {
  await pool.query(
    `insert into otc_overrides (asset_id, kind, interval_sec, target_price, base_price, candle_open_ms, candle_close_ms, ramp_ms,
                                created_by, ended_at, active)
     values ($1, 'otc', 60, $2, 100, $3, $4, 8000, $5, $6, $7)`,
    [assetId, target, openMs, openMs + MIN, userId, endedAt, active],
  );
}

beforeAll(async () => {
  pool = createPool(loadConfig());
  const a = await pool.query<{ id: number }>(
    `insert into assets (symbol, display, kind, enabled, otc_start_price, otc_vol_pct_hour, otc_decimals)
     values ($1, 'Marcas (OTC)', 'otc', true, 100, 1, 2) returning id`,
    [SYMBOL],
  );
  assetId = a.rows[0]!.id;
  const u = await pool.query<{ id: string }>(`insert into users (email, password_hash, name) values ($1, '!', 'Marks') returning id`, [
    `marks-${RUN}@override-marks.traderoom.test`,
  ]);
  userId = u.rows[0]!.id;

  // Ended normally inside the range (the candle at T0+2m), target above the open.
  await override(T0 + 2 * MIN, 101.5, new Date(T0 + 3 * MIN + 2000));
  // Ended normally inside the range, target below the open.
  await override(T0 + 5 * MIN, 98.25, new Date(T0 + 6 * MIN + 2000));
  // Outside the range: before the first candle and after the last one.
  await override(T0 - 3 * MIN, 102, new Date(T0 - 2 * MIN + 2000));
  await override(T0 + 20 * MIN, 102, new Date(T0 + 21 * MIN + 2000));
  // Released before its candle closed: the close was not the target.
  await override(T0 + 7 * MIN, 103, new Date(T0 + 7 * MIN + 10_000));

  app = await testApp({
    candles: { ...emptyCandles, get: async () => CANDLES },
    deps: { overrideMarks: createOverrideMarkSource(pool) },
  });
});

afterAll(async () => {
  await app?.close();
  await pool.query('delete from otc_overrides where asset_id = $1', [assetId]);
  await pool.query('delete from assets where id = $1', [assetId]);
  await pool.query('delete from users where id = $1', [userId]);
  await pool.end();
});

describe('GET /api/candles override marks', () => {
  it('marks the candles of ended overrides in range, and nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/candles?symbol=${SYMBOL}`, headers: { cookie: `sid=${FAKE_SID}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<CandlesResponse>();
    expect(body.marks).toEqual([
      { openMs: T0 + 2 * MIN, targetPrice: 101.5, direction: 'up' },
      { openMs: T0 + 5 * MIN, targetPrice: 98.25, direction: 'down' },
    ]);
    // Candles without an override carry no mark.
    const marked = new Set(body.marks.map((m) => m.openMs));
    expect(body.candles.filter((c) => !marked.has(c.t))).toHaveLength(8);
  });
});
