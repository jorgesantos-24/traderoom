import type { Redis } from 'ioredis';

/** The few Redis operations services need; tests use the in-memory version. */
export interface KvCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export function redisCache(redis: Redis): KvCache {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlMs) {
      await redis.set(key, value, 'PX', ttlMs);
    },
  };
}

export function memoryCache(now: () => number = Date.now): KvCache & { store: Map<string, { value: string; expiresAt: number }> } {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
  };
}
