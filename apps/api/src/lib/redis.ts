import { Redis } from 'ioredis';
import type { Config } from '../config.js';

export function createRedis(config: Pick<Config, 'REDIS_URL'>): Redis {
  return new Redis(config.REDIS_URL, {
    // Fail fast instead of queueing forever when Redis is down.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}
