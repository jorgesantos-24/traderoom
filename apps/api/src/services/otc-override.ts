import type pg from 'pg';
import {
  CANDLE_INTERVAL_MS,
  candleBucket,
  ErrorCode,
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_MIN_LEAD_MS,
  OTC_OVERRIDE_RELEASE_MS,
  otcOverridePhase,
  otcOverrideRampStartMs,
  RedisKeys,
  type AuditAction,
  type OtcOverrideAsset,
  type OtcOverrideInput,
  type OtcOverrideState,
  type OtcOverrideView,
  type OtcOverrideWire,
} from '@traderoom/shared';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

/** The Redis calls this service needs (ioredis satisfies it). */
export interface OverrideRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export interface OtcOverrideServiceDeps {
  pool: pg.Pool;
  redis: OverrideRedis;
  now?: () => number;
  /** Tests use their own key so a running ws is not disturbed. */
  key?: string;
}

export interface OtcOverrideService {
  get(): Promise<OtcOverrideState>;
  apply(adminId: string, input: OtcOverrideInput): Promise<OtcOverrideView>;
  /** False when nothing was active. */
  release(adminId: string): Promise<boolean>;
}

interface Row {
  id: string;
  asset_id: number;
  symbol: string;
  display: string;
  otc_decimals: number;
  interval_sec: number;
  target_price: string;
  base_price: string;
  candle_open_ms: string;
  candle_close_ms: string;
  ramp_ms: number;
  created_by: string;
  created_at: Date;
}

const ROW_SELECT = `
  select o.id::text as id, o.asset_id, a.symbol, a.display, a.otc_decimals, o.interval_sec,
         o.target_price::text as target_price, o.base_price::text as base_price,
         o.candle_open_ms::text as candle_open_ms, o.candle_close_ms::text as candle_close_ms,
         o.ramp_ms, o.created_by::text as created_by, o.created_at
    from otc_overrides o join assets a on a.id = o.asset_id`;

const rampStartOf = (createdMs: number, closeMs: number, rampMs: number) => otcOverrideRampStartMs(createdMs, closeMs, rampMs);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

async function audit(c: pg.PoolClient, adminId: string, action: AuditAction, payload: Record<string, unknown>): Promise<void> {
  await c.query('insert into admin_audit (admin_id, action, payload) values ($1, $2, $3)', [adminId, action, JSON.stringify(payload)]);
}

/** Overrides whose release is over are no longer active; this keeps the unique index free for the next one. */
async function expireFinished(db: pg.Pool | pg.PoolClient, nowMs: number): Promise<void> {
  await db.query(`update otc_overrides set active = false, ended_at = now() where active and candle_close_ms + $1 <= $2`, [
    OTC_OVERRIDE_RELEASE_MS,
    nowMs,
  ]);
}

async function readPrice(redis: OverrideRedis, symbol: string): Promise<string | null> {
  const raw = await redis.get(RedisKeys.price(symbol));
  if (!raw) return null;
  try {
    const p = (JSON.parse(raw) as { p?: unknown }).p;
    return typeof p === 'string' && Number(p) > 0 ? p : null;
  } catch {
    return null;
  }
}

const seconds = (ms: number) => `${Math.max(0, Math.ceil(ms / 1000))}s`;

export function createOtcOverrideService(deps: OtcOverrideServiceDeps): OtcOverrideService {
  const { pool, redis } = deps;
  const now = deps.now ?? Date.now;
  const key = deps.key ?? RedisKeys.otcOverride;

  const toView = (r: Row, currentPrice: string | null, nowMs: number): OtcOverrideView => {
    const closeMs = Number(r.candle_close_ms);
    const rampStartMs = rampStartOf(r.created_at.getTime(), closeMs, r.ramp_ms);
    return {
      id: r.id,
      assetId: r.asset_id,
      symbol: r.symbol,
      display: r.display,
      decimals: r.otc_decimals,
      intervalSec: r.interval_sec,
      targetPrice: Number(r.target_price),
      basePrice: Number(r.base_price),
      currentPrice: currentPrice === null ? null : Number(currentPrice),
      candleOpenMs: Number(r.candle_open_ms),
      candleCloseMs: closeMs,
      rampStartMs,
      holdStartMs: closeMs - OTC_OVERRIDE_HOLD_MS,
      releaseEndMs: closeMs + OTC_OVERRIDE_RELEASE_MS,
      remainingMs: closeMs - nowMs,
      phase: otcOverridePhase(nowMs, closeMs),
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    };
  };

  /** Message for the 409 when another override holds the slot. */
  async function busyMessage(): Promise<string> {
    const { rows } = await pool.query<Row>(`${ROW_SELECT} where o.active`);
    const r = rows[0];
    if (!r) return 'Já existe um override ativo.';
    return `Já existe um override ativo (ativo ${r.symbol}, faltam ${seconds(Number(r.candle_close_ms) - now())}).`;
  }

  return {
    async get() {
      const nowMs = now();
      await expireFinished(pool, nowMs);
      const [{ rows }, assets] = await Promise.all([
        pool.query<Row>(`${ROW_SELECT} where o.active`),
        pool.query<{ id: number; symbol: string; display: string; otc_decimals: number }>(
          `select id, symbol, display, otc_decimals from assets where kind = 'otc' and enabled order by sort, id`,
        ),
      ]);
      const r = rows[0];
      const override = r ? toView(r, await readPrice(redis, r.symbol), nowMs) : null;
      return {
        override,
        assets: assets.rows.map((a): OtcOverrideAsset => ({ id: a.id, symbol: a.symbol, display: a.display, decimals: a.otc_decimals })),
        serverNowMs: nowMs,
      };
    },

    async apply(adminId, input) {
      const stepMs = CANDLE_INTERVAL_MS[input.interval];
      let wire: OtcOverrideWire;
      let view: OtcOverrideView;
      let ttlMs: number;
      try {
        ({ wire, view, ttlMs } = await inTransaction(pool, async (c) => {
          const nowMs = now();
          await expireFinished(c, nowMs);
          const { rows: arows } = await c.query<{ id: number; symbol: string; kind: string; enabled: boolean; otc_decimals: number | null }>(
            'select id, symbol, kind, enabled, otc_decimals from assets where id = $1',
            [input.assetId],
          );
          const asset = arows[0];
          if (!asset) throw new AppError(404, ErrorCode.NotFound, 'Ativo não encontrado.');
          if (asset.kind !== 'otc' || asset.otc_decimals === null) {
            throw new AppError(400, ErrorCode.BadRequest, 'Só ativos OTC aceitam intervenção no preço.');
          }
          if (!asset.enabled) throw new AppError(400, ErrorCode.BadRequest, `${asset.symbol} está desativado.`);

          const base = await readPrice(redis, asset.symbol);
          if (base === null) {
            throw new AppError(409, ErrorCode.Conflict, `Sem cotação atual para ${asset.symbol}. O feed de preços está rodando?`);
          }
          const target = Number(input.targetPrice.toFixed(asset.otc_decimals));
          if (!(target > 0)) throw new AppError(400, ErrorCode.ValidationFailed, 'targetPrice: preço alvo inválido para as casas decimais do ativo.');

          const current = candleBucket(nowMs, stepMs);
          const { openMs, closeMs } = input.nextCandle ? { openMs: current.closeMs, closeMs: current.closeMs + stepMs } : current;
          const leadMs = closeMs - nowMs;
          if (!input.nextCandle && leadMs < OTC_OVERRIDE_MIN_LEAD_MS) {
            throw new AppError(
              409,
              ErrorCode.Conflict,
              `Faltam ${(leadMs / 1000).toFixed(1).replace('.', ',')} s para o fechamento; o mínimo é ${OTC_OVERRIDE_MIN_LEAD_MS / 1000} s. Aplique no próximo candle.`,
            );
          }
          const rampStartMs = otcOverrideRampStartMs(nowMs, closeMs, input.rampMs);
          const targetText = target.toFixed(asset.otc_decimals);

          const { rows } = await c.query<{ id: string; created_at: Date }>(
            `insert into otc_overrides (asset_id, interval_sec, target_price, base_price, candle_open_ms, candle_close_ms, ramp_ms, created_by, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text as id, created_at`,
            [asset.id, stepMs / 1000, targetText, base, openMs, closeMs, input.rampMs, adminId, new Date(nowMs)],
          );
          const inserted = rows[0];
          if (!inserted) throw new Error('otc override insert returned no row');
          await audit(c, adminId, 'otc.override', {
            overrideId: inserted.id,
            assetId: asset.id,
            symbol: asset.symbol,
            interval: input.interval,
            targetPrice: targetText,
            basePrice: base,
            candleOpenMs: openMs,
            candleCloseMs: closeMs,
            rampStartMs,
            nextCandle: input.nextCandle,
          });

          const w: OtcOverrideWire = {
            symbol: asset.symbol,
            targetPrice: targetText,
            basePrice: base,
            closeMs,
            rampStartMs,
            holdMs: OTC_OVERRIDE_HOLD_MS,
            releaseMs: OTC_OVERRIDE_RELEASE_MS,
          };
          const { rows: vrows } = await c.query<Row>(`${ROW_SELECT} where o.id = $1`, [inserted.id]);
          return { wire: w, view: toView(vrows[0] as Row, base, nowMs), ttlMs: closeMs + OTC_OVERRIDE_RELEASE_MS - nowMs + 10_000 };
        }));
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, ErrorCode.Conflict, await busyMessage());
        throw err;
      }

      try {
        await redis.set(key, JSON.stringify(wire), 'PX', ttlMs);
      } catch {
        // Without the key the ws never sees it; free the slot so the admin can retry.
        await pool.query('update otc_overrides set active = false, ended_at = now() where id = $1', [view.id]);
        throw new AppError(503, ErrorCode.Unavailable, 'Não foi possível publicar o override. Tente novamente.');
      }
      return view;
    },

    async release(adminId) {
      const released = await inTransaction(pool, async (c) => {
        const { rows } = await c.query<{ id: string; symbol: string; target_price: string; candle_close_ms: string }>(
          `update otc_overrides o set active = false, ended_at = now()
             from assets a
            where o.active and a.id = o.asset_id
            returning o.id::text as id, a.symbol, o.target_price::text as target_price, o.candle_close_ms::text as candle_close_ms`,
        );
        const r = rows[0];
        if (!r) return false;
        await audit(c, adminId, 'otc.override.release', {
          overrideId: r.id,
          symbol: r.symbol,
          targetPrice: r.target_price,
          candleCloseMs: Number(r.candle_close_ms),
          remainingMs: Number(r.candle_close_ms) - now(),
        });
        return true;
      });
      // Always cleared: a stale key with no active row must not keep steering the price.
      await redis.del(key);
      return released;
    },
  };
}
