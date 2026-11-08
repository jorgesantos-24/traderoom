import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { Registry } from '@traderoom/shared';
import type { SettleResult } from '../src/services/settlement.js';
import { SettlementWorker, WORKER_DEFAULTS, type DueQueue } from '../src/worker/settlement-worker.js';

const log = Fastify({ logger: false }).log;
const NOW = 1_800_000_000_000;

class FakeQueue implements DueQueue {
  readonly z = new Map<string, number>();
  async due(maxScore: number, limit: number): Promise<string[]> {
    return [...this.z]
      .filter(([, s]) => s <= maxScore)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }
  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.z.delete(id);
  }
  async add(entries: ReadonlyArray<{ id: string; score: number }>): Promise<void> {
    for (const e of entries) this.z.set(e.id, e.score);
  }
}

function setup(results: Record<string, SettleResult | Error>) {
  let now = NOW;
  const queue = new FakeQueue();
  const seen: Array<[string, number]> = [];
  let active = 0;
  let maxActive = 0;
  const metrics = new Registry();
  const worker = new SettlementWorker(
    {
      pool: {} as pg.Pool,
      queue,
      log,
      metrics,
      now: () => now,
      settle: async (_pool, id, nowMs) => {
        seen.push([id, nowMs]);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        const r = results[id];
        if (r instanceof Error) throw r;
        return r ?? { kind: 'missing' };
      },
    },
    { ...WORKER_DEFAULTS, concurrency: 3, retryAfterMs: 5000 },
  );
  return { worker, queue, seen, metrics, maxActive: () => maxActive, advance: (ms: number) => (now += ms) };
}

const won = (expiresAtMs: number): SettleResult => ({ kind: 'settled', status: 'won', creditCents: 1870, userId: 'u', expiresAtMs });

describe('SettlementWorker.round', () => {
  it('settles only orders past expiry + grace and removes them from the queue', async () => {
    const s = setup({ a: won(NOW - 5000), b: won(NOW - 2000) });
    await s.queue.add([
      { id: 'a', score: NOW - 5000 },
      { id: 'b', score: NOW - 2000 },
      { id: 'c', score: NOW - 1000 }, // inside the 1.5 s grace
      { id: 'd', score: NOW + 60_000 },
    ]);
    expect(await s.worker.round()).toBe(2);
    expect(s.seen.map(([id]) => id).sort()).toEqual(['a', 'b']);
    expect(s.seen[0]?.[1]).toBe(NOW - WORKER_DEFAULTS.graceMs);
    expect([...s.queue.z.keys()].sort()).toEqual(['c', 'd']);
    expect(s.metrics.render()).toContain('settlements_total{status="won"} 2');
  });

  it('drops already-settled and missing orders, keeps not-due ones', async () => {
    const s = setup({ a: { kind: 'already_settled' }, b: { kind: 'missing' }, c: { kind: 'not_due' } });
    await s.queue.add(['a', 'b', 'c'].map((id) => ({ id, score: NOW - 10_000 })));
    expect(await s.worker.round()).toBe(0);
    expect([...s.queue.z.keys()]).toEqual(['c']);
  });

  it('keeps a failing order queued and retries it only after the back-off', async () => {
    const s = setup({ bad: new Error('deadlock'), ok: won(NOW - 9000) });
    await s.queue.add([
      { id: 'bad', score: NOW - 10_000 },
      { id: 'ok', score: NOW - 9000 },
    ]);
    await s.worker.round();
    expect([...s.queue.z.keys()]).toEqual(['bad']);
    expect(s.metrics.render()).toContain('settlement_errors_total 1');
    s.seen.length = 0;
    s.advance(1000);
    await s.worker.round();
    expect(s.seen).toEqual([]);
    s.advance(4000);
    await s.worker.round();
    expect(s.seen.map(([id]) => id)).toEqual(['bad']);
  });

  it('runs at most `concurrency` settlements at once', async () => {
    const results = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o${i}`, won(NOW - 10_000)]));
    const s = setup(results);
    await s.queue.add(Object.keys(results).map((id) => ({ id, score: NOW - 10_000 })));
    expect(await s.worker.round()).toBe(12);
    expect(s.maxActive()).toBe(3);
    expect(s.queue.z.size).toBe(0);
  });
});
