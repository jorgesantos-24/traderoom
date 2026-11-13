import type pg from 'pg';
import {
  CANDLE_INTERVAL_MS,
  candleBucket,
  ErrorCode,
  OTC_OVERRIDE_HOLD_MS,
  OTC_OVERRIDE_LANDING_MS,
  OTC_OVERRIDE_MIN_LEAD_MS,
  OTC_OVERRIDE_SCHEDULE_HORIZON_MS,
  otcOverridePhase,
  otcOverrideRampStartMs,
  RedisKeys,
  type AuditAction,
  type OtcExposure,
  type OtcExposureBucket,
  type OtcExposureQuery,
  type OtcOverrideAsset,
  type OtcOverrideInput,
  type OtcOverrideScheduleInput,
  type OtcOverrideState,
  type OtcOverrideView,
  type OtcOverrideWire,
  type OverrideDirection,
  type PriceOverrideKind,
  type PublicOverrideState,
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
  /** What clients see: whether the platform is setting this symbol's price now. */
  publicState(symbol: string): Promise<PublicOverrideState>;
  /** Open bets on one asset right now (real accounts), and the house result at a price. */
  exposure(q: OtcExposureQuery): Promise<OtcExposure>;
}

interface Row {
  id: string;
  kind: PriceOverrideKind;
  asset_id: number;
  symbol: string;
  display: string;
  decimals: number;
  interval_sec: number;
  target_price: string | null;
  base_price: string;
  direction: OverrideDirection | null;
  body_ticks: number | null;
  candle_open_ms: string;
  candle_close_ms: string;
  ramp_ms: number;
  release_ms: number;
  ignore_band: boolean;
  created_by: string;
  created_at: Date;
}

interface AssetRow {
  id: number;
  symbol: string;
  kind: PriceOverrideKind;
  enabled: boolean;
  decimals: number | null;
  max_override_pct: string;
  market_jitter: boolean;
}

const ROW_SELECT = `
  select o.id::text as id, o.kind, o.asset_id, a.symbol, a.display, coalesce(a.otc_decimals, a.price_decimals) as decimals, o.interval_sec,
         o.target_price::text as target_price, o.base_price::text as base_price, o.direction, o.body_ticks,
         o.candle_open_ms::text as candle_open_ms, o.candle_close_ms::text as candle_close_ms,
         o.ramp_ms, o.release_ms, o.ignore_band, o.created_by::text as created_by, o.created_at
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
  await db.query(`update otc_overrides set active = false, ended_at = now() where active and candle_close_ms + release_ms <= $1`, [
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
      kind: r.kind,
      assetId: r.asset_id,
      symbol: r.symbol,
      display: r.display,
      decimals: r.decimals,
      intervalSec: r.interval_sec,
      targetPrice: r.target_price === null ? null : Number(r.target_price),
      basePrice: Number(r.base_price),
      schedule: r.direction !== null && r.body_ticks !== null ? { direction: r.direction, ticks: r.body_ticks } : null,
      currentPrice: currentPrice === null ? null : Number(currentPrice),
      candleOpenMs: Number(r.candle_open_ms),
      candleCloseMs: closeMs,
      rampStartMs,
      holdStartMs: closeMs - OTC_OVERRIDE_HOLD_MS,
      releaseEndMs: closeMs + r.release_ms,
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

  /**
   * Scheduled mode: books the 1m candle opening at atMs. Nothing is priced now; the ws resolves the
   * target from the open (last tick before the rollover) and only touches ticks from atMs on.
   */
  async function applyScheduled(
    c: pg.PoolClient,
    adminId: string,
    asset: AssetRow,
    base: string,
    s: OtcOverrideScheduleInput,
    nowMs: number,
    releaseMs: number,
    ignoreBand: boolean,
  ): Promise<{ wire: OtcOverrideWire; view: OtcOverrideView; ttlMs: number }> {
    if (s.atMs <= nowMs + OTC_OVERRIDE_MIN_LEAD_MS) {
      throw new AppError(
        400,
        ErrorCode.ValidationFailed,
        `schedule.atMs: o minuto tem que começar daqui a mais de ${OTC_OVERRIDE_MIN_LEAD_MS / 1000} s.`,
      );
    }
    if (s.atMs > nowMs + OTC_OVERRIDE_SCHEDULE_HORIZON_MS) {
      throw new AppError(
        400,
        ErrorCode.ValidationFailed,
        `schedule.atMs: só dá para agendar até ${OTC_OVERRIDE_SCHEDULE_HORIZON_MS / 60_000} min à frente.`,
      );
    }
    const openMs = s.atMs;
    const closeMs = openMs + CANDLE_INTERVAL_MS['1m'];
    // The ramp spans the whole candle: from the open to the landing.
    const rampMs = closeMs - openMs - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS;
    const { rows } = await c.query<{ id: string }>(
      `insert into otc_overrides (asset_id, kind, interval_sec, target_price, base_price, candle_open_ms, candle_close_ms, ramp_ms,
                                  release_ms, ignore_band, direction, body_ticks, created_by, created_at)
       values ($1, 'market', 60, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text as id`,
      [asset.id, base, openMs, closeMs, rampMs, releaseMs, ignoreBand, s.direction, s.ticks, adminId, new Date(nowMs)],
    );
    const inserted = rows[0];
    if (!inserted) throw new Error('otc override insert returned no row');
    await audit(c, adminId, 'otc.override', {
      overrideId: inserted.id,
      kind: 'market',
      assetId: asset.id,
      symbol: asset.symbol,
      interval: '1m',
      basePrice: base,
      candleOpenMs: openMs,
      candleCloseMs: closeMs,
      rampStartMs: openMs,
      releaseMs,
      ignoreBand,
      schedule: { atMs: s.atMs, direction: s.direction, ticks: s.ticks },
    });
    const wire: OtcOverrideWire = {
      id: inserted.id,
      kind: 'market',
      jitter: asset.market_jitter,
      symbol: asset.symbol,
      basePrice: base,
      closeMs,
      rampStartMs: openMs,
      holdMs: OTC_OVERRIDE_HOLD_MS,
      releaseMs,
      schedule: {
        openMs,
        direction: s.direction,
        ticks: s.ticks,
        maxOverridePct: Number(asset.max_override_pct),
        ...(ignoreBand ? { ignoreBand: true } : {}),
      },
    };
    const { rows: vrows } = await c.query<Row>(`${ROW_SELECT} where o.id = $1`, [inserted.id]);
    // TTL from closeMs, like the immediate mode: the key outlives the release.
    return { wire, view: toView(vrows[0] as Row, base, nowMs), ttlMs: closeMs + releaseMs - nowMs + 10_000 };
  }

  return {
    async exposure({ assetId, closeMs, price }) {
      const close = closeMs ?? null;
      const at = close === null || price === undefined ? null : String(price);
      // $2: closeMs or null; "closing" = expires by the candle close. $3: price, as numeric.
      const CLOSING = `($2::bigint is not null and o.expires_at <= to_timestamp($2::bigint / 1000.0))`;
      const [bySide, people] = await Promise.all([
        pool.query<{ direction: 'call' | 'put'; n: number; stake: string; n_c: number; stake_c: string; house: string }>(
          `select o.direction, count(*)::int as n, sum(o.stake_cents)::text as stake,
                  count(*) filter (where ${CLOSING})::int as n_c,
                  coalesce(sum(o.stake_cents) filter (where ${CLOSING}), 0)::text as stake_c,
                  coalesce(sum(case
                      when $3::numeric is null or o.open_price = $3::numeric then 0
                      when (o.direction = 'call') = ($3::numeric > o.open_price) then -((o.stake_cents * o.payout_pct) / 100)
                      else o.stake_cents end) filter (where ${CLOSING}), 0)::text as house
             from orders o
            where o.asset_id = $1 and o.status = 'open' and o.account = 'real'
            group by o.direction`,
          [assetId, close, at],
        ),
        pool.query<{ t: number; t_c: number }>(
          `select count(distinct o.user_id)::int as t,
                  count(distinct o.user_id) filter (where ${CLOSING})::int as t_c
             from orders o
            where o.asset_id = $1 and o.status = 'open' and o.account = 'real'`,
          [assetId, close],
        ),
      ]);
      const empty = () => ({ orders: 0, stakeCents: 0 });
      const open: OtcExposureBucket = { call: empty(), put: empty(), traders: people.rows[0]?.t ?? 0 };
      const closing: OtcExposureBucket = { call: empty(), put: empty(), traders: people.rows[0]?.t_c ?? 0 };
      let house = 0;
      for (const r of bySide.rows) {
        open[r.direction] = { orders: r.n, stakeCents: Number(r.stake) };
        closing[r.direction] = { orders: r.n_c, stakeCents: Number(r.stake_c) };
        house += Number(r.house);
      }
      return {
        open,
        closing: close === null ? null : closing,
        houseAtPriceCents: at === null ? null : house,
        serverNowMs: now(),
      };
    },

    async get() {
      const nowMs = now();
      await expireFinished(pool, nowMs);
      const [{ rows }, assets] = await Promise.all([
        pool.query<Row>(`${ROW_SELECT} where o.active`),
        pool.query<{ id: number; kind: PriceOverrideKind; symbol: string; display: string; decimals: number; max_override_pct: string }>(
          `select id, kind, symbol, display, coalesce(otc_decimals, price_decimals) as decimals, max_override_pct::text as max_override_pct
             from assets where enabled and coalesce(otc_decimals, price_decimals) is not null order by kind desc, sort, id`,
        ),
      ]);
      const r = rows[0];
      const override = r ? toView(r, await readPrice(redis, r.symbol), nowMs) : null;
      return {
        override,
        assets: assets.rows.map((a): OtcOverrideAsset => ({
          id: a.id,
          kind: a.kind,
          symbol: a.symbol,
          display: a.display,
          decimals: a.decimals,
          maxOverridePct: a.kind === 'market' ? Number(a.max_override_pct) : null,
        })),
        serverNowMs: nowMs,
      };
    },

    async apply(adminId, input) {
      let wire: OtcOverrideWire;
      let view: OtcOverrideView;
      let ttlMs: number;
      const schedule = input.schedule;
      try {
        ({ wire, view, ttlMs } = await inTransaction(pool, async (c) => {
          const nowMs = now();
          await expireFinished(c, nowMs);
          const { rows: arows } = await c.query<AssetRow>(
            `select id, symbol, kind, enabled, coalesce(otc_decimals, price_decimals) as decimals,
                    max_override_pct::text as max_override_pct, market_jitter
               from assets where id = $1`,
            [input.assetId],
          );
          const asset = arows[0];
          if (!asset) throw new AppError(404, ErrorCode.NotFound, 'Ativo não encontrado.');
          const market = asset.kind === 'market';
          if (schedule && !market) {
            throw new AppError(400, ErrorCode.BadRequest, 'O modo agendado só vale para ativos de mercado.');
          }
          if (market && input.interval !== '1m') {
            throw new AppError(400, ErrorCode.BadRequest, 'Ativos de mercado só aceitam intervenção no candle de 1m.');
          }
          if (asset.decimals === null) {
            throw new AppError(400, ErrorCode.BadRequest, `${asset.symbol} não tem casas decimais configuradas.`);
          }
          const decimals = asset.decimals;
          if (!asset.enabled) throw new AppError(400, ErrorCode.BadRequest, `${asset.symbol} está desativado.`);
          const stepMs = CANDLE_INTERVAL_MS[input.interval];

          const base = await readPrice(redis, asset.symbol);
          if (base === null) {
            throw new AppError(409, ErrorCode.Conflict, `Sem cotação atual para ${asset.symbol}. O feed de preços está rodando?`);
          }
          if (schedule) return applyScheduled(c, adminId, asset, base, schedule, nowMs, input.releaseMs, input.ignoreBand);
          if (input.targetPrice === undefined) throw new AppError(400, ErrorCode.ValidationFailed, 'targetPrice: informe o preço alvo.');
          const target = Number(input.targetPrice.toFixed(decimals));
          if (!(target > 0))
            throw new AppError(400, ErrorCode.ValidationFailed, 'targetPrice: preço alvo inválido para as casas decimais do ativo.');
          // ignoreBand: o admin assume o risco de um alvo longe do preço real.
          if (market && !input.ignoreBand) {
            const maxPct = Number(asset.max_override_pct);
            const devPct = (Math.abs(target - Number(base)) / Number(base)) * 100;
            if (devPct > maxPct) {
              const pct = (n: number) => n.toFixed(3).replace('.', ',');
              throw new AppError(
                400,
                ErrorCode.ValidationFailed,
                `targetPrice: desvio de ${pct(devPct)}% do preço atual (${base}); o limite de ${asset.symbol} é ${pct(maxPct)}%. Envie ignoreBand para passar.`,
              );
            }
          }

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
          // Market and OTC: the ramp spans the rest of the candle, up to 60 s (the client's rampMs is ignored),
          // so the move is gradual instead of a sharp run in the last seconds.
          const rampMs = Math.min(60_000, Math.max(500, leadMs - OTC_OVERRIDE_HOLD_MS - OTC_OVERRIDE_LANDING_MS));
          const rampStartMs = otcOverrideRampStartMs(nowMs, closeMs, rampMs);
          const targetText = target.toFixed(decimals);
          const releaseMs = input.releaseMs;

          const { rows } = await c.query<{ id: string; created_at: Date }>(
            `insert into otc_overrides (asset_id, kind, interval_sec, target_price, base_price, candle_open_ms, candle_close_ms, ramp_ms,
                                        release_ms, ignore_band, created_by, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text as id, created_at`,
            [
              asset.id,
              asset.kind,
              stepMs / 1000,
              targetText,
              base,
              openMs,
              closeMs,
              rampMs,
              releaseMs,
              input.ignoreBand,
              adminId,
              new Date(nowMs),
            ],
          );
          const inserted = rows[0];
          if (!inserted) throw new Error('otc override insert returned no row');
          await audit(c, adminId, 'otc.override', {
            overrideId: inserted.id,
            kind: asset.kind,
            assetId: asset.id,
            symbol: asset.symbol,
            interval: input.interval,
            targetPrice: targetText,
            basePrice: base,
            candleOpenMs: openMs,
            candleCloseMs: closeMs,
            rampStartMs,
            releaseMs,
            ignoreBand: input.ignoreBand,
            nextCandle: input.nextCandle,
          });

          const w: OtcOverrideWire = {
            id: inserted.id,
            ...(market ? { kind: 'market' as const, jitter: asset.market_jitter } : {}),
            symbol: asset.symbol,
            targetPrice: targetText,
            basePrice: base,
            closeMs,
            rampStartMs,
            holdMs: OTC_OVERRIDE_HOLD_MS,
            releaseMs,
          };
          const { rows: vrows } = await c.query<Row>(`${ROW_SELECT} where o.id = $1`, [inserted.id]);
          return { wire: w, view: toView(vrows[0] as Row, base, nowMs), ttlMs: closeMs + releaseMs - nowMs + 10_000 };
        }));
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Scheduled: the slot is busy for the booked time, a bad request like any other invalid time.
          throw schedule
            ? new AppError(400, ErrorCode.BadRequest, await busyMessage())
            : new AppError(409, ErrorCode.Conflict, await busyMessage());
        }
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

    async publicState(symbol) {
      const { rows } = await pool.query<{ scheduled_for: string | null; candle_close_ms: string; release_ms: number }>(
        `select case when o.direction is not null then o.candle_open_ms::text end as scheduled_for,
                o.candle_close_ms::text as candle_close_ms, o.release_ms
           from otc_overrides o join assets a on a.id = o.asset_id
          where o.active and a.symbol = $1 and o.candle_close_ms + o.release_ms > $2`,
        [symbol, now()],
      );
      const r = rows[0];
      if (!r) return { active: false, untilMs: null, scheduledFor: null };
      // Active from creation, before the ramp moves anything. Never carries the target.
      return {
        active: true,
        untilMs: Number(r.candle_close_ms) + r.release_ms,
        scheduledFor: r.scheduled_for === null ? null : Number(r.scheduled_for),
      };
    },
  };
}
