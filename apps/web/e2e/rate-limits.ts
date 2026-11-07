import { existsSync } from 'node:fs';
import { Redis } from 'ioredis';

const ENV_FILE = new URL('../../../.env', import.meta.url);
if (!process.env.REDIS_URL && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/**
 * The API allows 5 sign-ups per IP per hour and 10 logins per 5 min, and every E2E run signs up
 * from 127.0.0.1. Clear those counters (dev Redis only) so repeated runs do not hit the limit.
 */
export async function resetAuthRateLimits(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to touch rate limits in production');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const keys: string[] = [];
    for (const pattern of ['rl:POST/api/auth/register-*', 'rl:POST/api/auth/login-*']) {
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
    }
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
