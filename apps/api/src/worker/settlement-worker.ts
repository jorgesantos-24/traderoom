import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { RedisKeys, type Counter, type Gauge, type Registry } from '@traderoom/shared';
import { SETTLE_GRACE_MS, settleOrder, type SettleResult } from '../services/settlement.js';

export interface DueQueue {
  /** Order ids with score (expires_at ms) <= maxScore, oldest first. */
  due(maxScore: number, limit: number): Promise<string[]>;
  remove(ids: readonly string[]): Promise<void>;
  add(entries: ReadonlyArray<{ id: string; score: number }>): Promise<void>;
}

export interface RedisZset {
  zrangebyscore(key: string, min: string, max: number, limit: 'LIMIT', offset: number, count: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zadd(key: string, ...args: Array<string | number>): Promise<number | string | null>;
}

export function redisDueQueue(redis: RedisZset, key: string = RedisKeys.ordersDue): DueQueue {
  return {
    due: (maxScore, limit) => redis.zrangebyscore(key, '-inf', maxScore, 'LIMIT', 0, limit),
    async remove(ids) {
      if (ids.length > 0) await redis.zrem(key, ...ids);
    },
    async add(entries) {
      if (entries.length === 0) return;
      await redis.zadd(key, ...entries.flatMap((e) => [e.score, e.id]));
    },
  };
}

export interface SettlementWorkerOptions {
  tickMs: number;
  sweepMs: number;
  graceMs: number;
  batchSize: number;
  concurrency: number;
  /** After a failure, an order is retried no sooner than this. */
  retryAfterMs: number;
}

export const WORKER_DEFAULTS: SettlementWorkerOptions = {
  tickMs: 250,
  sweepMs: 10_000,
  graceMs: SETTLE_GRACE_MS,
  batchSize: 200,
  concurrency: 4,
  retryAfterMs: 5000,
};

export interface SettlementWorkerDeps {
  pool: pg.Pool;
  queue: DueQueue;
  log: FastifyBaseLogger;
  metrics: Registry;
  settle?: (pool: pg.Pool, id: string, nowMs: number) => Promise<SettleResult>;
  now?: () => number;
}

/** Pulls due orders from `orders:due` every tick and settles them; a DB sweep catches anything Redis lost. */
export class SettlementWorker {
  private readonly now: () => number;
  private readonly settle: NonNullable<SettlementWorkerDeps['settle']>;
  private readonly failedAt = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private roundInFlight: Promise<number> | null = null;
  private sweepInFlight = false;
  private lastRoundMs: number | null = null;
  private readonly m: {
    settled: Counter;
    errors: Counter;
    recovered: Counter;
    lag: Gauge;
    backlog: Gauge;
  };

  constructor(
    private readonly deps: SettlementWorkerDeps,
    private readonly opts: SettlementWorkerOptions = WORKER_DEFAULTS,
  ) {
    this.now = deps.now ?? Date.now;
    this.settle = deps.settle ?? settleOrder;
    const reg = deps.metrics;
    this.m = {
      settled: reg.counter('settlements_total', 'Orders settled, by result.'),
      errors: reg.counter('settlement_errors_total', 'Failed settlement attempts.'),
      recovered: reg.counter('settlement_sweep_recovered_total', 'Due orders found by the DB sweep and re-queued.'),
      lag: reg.gauge('settlement_lag_ms', 'Last settlement time minus order expiry.'),
      backlog: reg.gauge('settlement_due_batch', 'Due orders picked up in the last round.'),
    };
  }

  start(): void {
    this.timers.push(setInterval(() => void this.tick(), this.opts.tickMs));
    this.timers.push(setInterval(() => void this.sweep(), this.opts.sweepMs));
    void this.sweep();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    await this.roundInFlight?.catch(() => 0);
  }

  /** Epoch ms of the last completed round, for health checks. */
  get lastRound(): number | null {
    return this.lastRoundMs;
  }

  private async tick(): Promise<void> {
    if (this.roundInFlight) return;
    this.roundInFlight = this.round().catch((err: unknown) => {
      this.deps.log.error({ err }, 'settlement round failed');
      return 0;
    });
    try {
      await this.roundInFlight;
    } finally {
      this.roundInFlight = null;
    }
  }

  /** One pass over due orders; returns how many were settled. */
  async round(): Promise<number> {
    const now = this.now();
    const ids = (await this.deps.queue.due(now - this.opts.graceMs, this.opts.batchSize)).filter((id) => {
      const failed = this.failedAt.get(id);
      return failed === undefined || now - failed >= this.opts.retryAfterMs;
    });
    this.m.backlog.set({}, ids.length);
    let settled = 0;
    const done: string[] = [];
    let next = 0;
    const workerLoop = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++] as string;
        try {
          const r = await this.settle(this.deps.pool, id, now - this.opts.graceMs);
          if (r.kind === 'not_due') continue;
          this.failedAt.delete(id);
          done.push(id);
          if (r.kind === 'settled') {
            settled += 1;
            this.m.settled.inc({ status: r.status });
            this.m.lag.set({}, this.now() - r.expiresAtMs);
          }
        } catch (err) {
          this.failedAt.set(id, this.now());
          this.m.errors.inc();
          this.deps.log.error({ err, orderId: id }, 'failed to settle order; will retry');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, ids.length) }, workerLoop));
    await this.deps.queue.remove(done);
    this.lastRoundMs = this.now();
    return settled;
  }

  /** Re-queues open orders past expiry that are missing from Redis (flush, failed ZADD). */
  async sweep(): Promise<number> {
    if (this.sweepInFlight) return 0;
    this.sweepInFlight = true;
    try {
      const { rows } = await this.deps.pool.query<{ id: string; expires_ms: string }>(
        `select id, (extract(epoch from expires_at) * 1000)::bigint as expires_ms
           from orders
          where status = 'open' and expires_at <= now() - make_interval(secs => $1)
          order by expires_at
          limit 1000`,
        [(this.opts.graceMs * 2) / 1000],
      );
      await this.deps.queue.add(rows.map((r) => ({ id: r.id, score: Number(r.expires_ms) })));
      if (rows.length > 0) {
        this.m.recovered.inc({}, rows.length);
        this.deps.log.warn({ count: rows.length }, 'sweep re-queued due orders');
      }
      return rows.length;
    } catch (err) {
      this.deps.log.error({ err }, 'settlement sweep failed');
      return 0;
    } finally {
      this.sweepInFlight = false;
    }
  }
}
