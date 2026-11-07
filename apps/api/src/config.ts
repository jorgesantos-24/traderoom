import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.url().transform((u) => u.replace(/\/+$/, '')),
  COOKIE_SECURE: z.stringbool().default(true),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(120),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  REDIS_URL: z.url(),
  BINANCE_REST_URL: z.url().default('https://data-api.binance.vision'),
  FEED_STALE_MS: z.coerce.number().int().positive().default(2000),
  // Entry price = first price received this long after the order arrives (anti latency-arbitrage).
  ORDER_ENTRY_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(500),
  HEALTH_FEED_MAX_AGE_MS: z.coerce.number().int().positive().default(5000),
  /** Resend API key; without it, password reset e-mails are dropped outside development. */
  RESEND_API_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  MAIL_FROM: z.string().trim().min(3).default('Traderoom <nao-responda@localhost>'),
  /** Novus Pagamentos private key (Integrações > Chave Privada). Without it, deposits and withdrawals are off. */
  NOVUS_API_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  NOVUS_API_URL: z.url().default('https://api.novuspagamentos.com/api/v2'),
  /** Secret (whsec_...) of a global webhook set up in the Novus dashboard; optional, postbacks are signed with the API key. */
  NOVUS_WEBHOOK_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  /** Send the gateway a postback URL (PUBLIC_ORIGIN + /api/webhooks/novus). Off in dev, where the gateway cannot reach us. */
  NOVUS_POSTBACKS: z.stringbool().default(false),
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
