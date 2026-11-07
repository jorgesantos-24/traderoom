import { z } from 'zod';
import { FEED_STALE_MS } from '@traderoom/shared';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WS_HOST: z.string().min(1).default('127.0.0.1'),
  WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  // Browser Origin allowed on /ws (same value the API uses for CORS).
  PUBLIC_ORIGIN: z.url().transform((u) => u.replace(/\/+$/, '')),
  DATABASE_URL: z.url(),
  // Relay (asset reload, snapshots) plus session lookups on handshakes and revalidation.
  WS_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(8),
  REDIS_URL: z.url(),
  BINANCE_WS_URL: z.url().default('wss://data-stream.binance.vision:443/stream'),
  // Backup on different Binance infrastructure; same market, so a failover never changes the price.
  BINANCE_BACKUP_WS_URL: z.url().default('wss://stream.binance.com:443/stream'),
  FEED_STALE_MS: z.coerce.number().int().positive().default(FEED_STALE_MS),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
