import type { FeedHealthCheck, HealthCheck, HealthResponse } from '@traderoom/shared';

export interface HealthDeps {
  pingPostgres(): Promise<void>;
  pingRedis(): Promise<void>;
  /** Epoch ms of the newest tick, or null if none was ever recorded. */
  getLastTickMs(): Promise<number | null>;
  now(): number;
  feedMaxAgeMs: number;
  /** Per-dependency timeout. */
  timeoutMs: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function timed(fn: () => Promise<void>, timeoutMs: number): Promise<HealthCheck> {
  const start = performance.now();
  try {
    await withTimeout(fn(), timeoutMs);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: errorMessage(err) };
  }
}

async function checkFeed(deps: HealthDeps): Promise<FeedHealthCheck> {
  try {
    const last = await withTimeout(deps.getLastTickMs(), deps.timeoutMs);
    if (last === null || !Number.isFinite(last)) return { ok: false, ageMs: null, error: 'no tick recorded' };
    const ageMs = Math.max(0, deps.now() - last);
    return ageMs > deps.feedMaxAgeMs
      ? { ok: false, ageMs, error: `last tick older than ${deps.feedMaxAgeMs} ms` }
      : { ok: true, ageMs };
  } catch (err) {
    return { ok: false, ageMs: null, error: errorMessage(err) };
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthResponse> {
  const [postgres, redis, feed] = await Promise.all([
    timed(deps.pingPostgres, deps.timeoutMs),
    timed(deps.pingRedis, deps.timeoutMs),
    checkFeed(deps),
  ]);
  const ok = postgres.ok && redis.ok && feed.ok;
  return { status: ok ? 'ok' : 'fail', checks: { postgres, redis, feed } };
}
