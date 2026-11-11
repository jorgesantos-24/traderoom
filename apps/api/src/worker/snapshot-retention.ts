import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Counter, Registry } from '@traderoom/shared';

export interface RetentionOptions {
  retentionDays: number;
  /** Rows per delete statement: short transactions, no long locks on a hot table. */
  batchSize: number;
  everyMs: number;
  /** First run after start, so a restart loop does not hammer the database. */
  firstRunMs: number;
}

export const RETENTION_DEFAULTS: RetentionOptions = { retentionDays: 7, batchSize: 10_000, everyMs: 3_600_000, firstRunMs: 60_000 };

export interface RetentionDeps {
  pool: pg.Pool;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
  metrics: Registry;
  now?: () => number;
}

/**
 * Deletes price_snapshots older than the retention window. Settlement only reads the last
 * seconds before expiry; the rest is kept for investigating disputed orders.
 * Before deleting, each minute is rolled up into price_candles_1m so the chart history stays.
 * Works per asset so each batch uses the (asset_id, captured_at) index.
 */
export class SnapshotRetention {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private readonly deleted: Counter;

  constructor(
    private readonly deps: RetentionDeps,
    private readonly opts: RetentionOptions = RETENTION_DEFAULTS,
  ) {
    this.deleted = deps.metrics.counter('snapshots_pruned_total', 'price_snapshots rows deleted by retention.');
  }

  start(): void {
    this.timers.push(setTimeout(() => void this.run(), this.opts.firstRunMs));
    this.timers.push(setInterval(() => void this.run(), this.opts.everyMs));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** One full pass; returns rows deleted. Never throws. */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    // On a minute boundary: only whole minutes are rolled up and deleted.
    const cutoff = new Date(Math.floor(((this.deps.now ?? Date.now)() - this.opts.retentionDays * 86_400_000) / 60_000) * 60_000);
    let total = 0;
    try {
      const { rows: assets } = await this.deps.pool.query<{ id: number }>('select id from assets order by id');
      for (const { id } of assets) {
        // Kept rows win: a minute rolled up before (e.g. a run that stopped before deleting) is not rewritten.
        await this.deps.pool.query(
          `insert into price_candles_1m (asset_id, t, o, h, l, c)
           select $1, b, (array_agg(price order by captured_at asc))[1], max(price), min(price),
                  (array_agg(price order by captured_at desc))[1]
             from (select date_bin(interval '1 minute', captured_at, timestamptz 'epoch') as b, price, captured_at
                     from price_snapshots where asset_id = $1 and captured_at < $2) s
            group by b
           on conflict (asset_id, t) do nothing`,
          [id, cutoff],
        );
        for (;;) {
          const r = await this.deps.pool.query(
            `delete from price_snapshots
              where ctid = any(array(
                select ctid from price_snapshots where asset_id = $1 and captured_at < $2 limit $3))`,
            [id, cutoff, this.opts.batchSize],
          );
          const n = r.rowCount ?? 0;
          total += n;
          if (n < this.opts.batchSize) break;
        }
      }
      if (total > 0) {
        this.deleted.inc({}, total);
        this.deps.log.info({ deleted: total, cutoff: cutoff.toISOString() }, 'pruned old price snapshots');
      }
    } catch (err) {
      this.deps.log.error({ err }, 'snapshot retention failed; will retry next round');
    } finally {
      this.running = false;
    }
    return total;
  }
}
