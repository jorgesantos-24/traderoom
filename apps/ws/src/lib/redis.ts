import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    // Price writes are fire-and-forget every 200 ms: fail fast instead of queueing stale writes.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}
