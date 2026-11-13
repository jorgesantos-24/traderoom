import { z } from 'zod';

const optionalSecret = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional());

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
  /** SMTP mailbox (Hostinger Email: smtp.hostinger.com, 465). Takes precedence over Resend when SMTP_PASS is set. */
  SMTP_HOST: z.string().trim().min(1).default('smtp.hostinger.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  /** Mailbox login; empty = the address inside MAIL_FROM. */
  SMTP_USER: optionalSecret,
  SMTP_PASS: optionalSecret,
  MAIL_FROM: z.string().trim().min(3).default('Traderoom <nao-responda@localhost>'),
  /** Novus Pagamentos private key (Integrações > Chave Privada). Without it, deposits and withdrawals are off. */
  NOVUS_API_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  NOVUS_API_URL: z.url().default('https://api.novuspagamentos.com/api/v2'),
  /** Secret (whsec_...) of a global webhook set up in the Novus dashboard; optional, postbacks are signed with the API key. */
  NOVUS_WEBHOOK_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
  /** Old name of PAYMENT_POSTBACKS, still read. */
  NOVUS_POSTBACKS: z.stringbool().optional(),
  /** EaglePay (Painel → Integrações → API e Webhooks): Client ID, Public Key (Pix charges), Secret Key (withdrawals, webhook signature). */
  EAGLE_CLIENT_ID: optionalSecret,
  EAGLE_PUBLIC_KEY: optionalSecret,
  EAGLE_SECRET_KEY: optionalSecret,
  EAGLE_API_URL: z.url().default('https://api.eaglepagamentos.com.br'),
  /**
   * Gateway for new deposits and withdrawals. Unset: EaglePay when its three keys are set, else Novus when its key is set.
   * Any other configured gateway keeps serving the transactions it already holds.
   */
  PAYMENT_PROVIDER: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.enum(['eagle', 'novus']).optional()),
  /** Send the gateway a postback URL (PUBLIC_ORIGIN + /api/webhooks/<gateway>). Off in dev, where the gateway cannot reach us. */
  PAYMENT_POSTBACKS: z.stringbool().optional(),
  /** How often open deposits/withdrawals are checked with the gateway (EaglePay has no withdrawal webhook). 0 = never. */
  PAYMENT_SYNC_MS: z.coerce.number().int().min(0).default(60_000),
  /** Broker fee kept on each withdrawal, in percent of the amount the client asks for (100 asked → 2 kept, 98 sent). */
  WITHDRAW_FEE_PCT: z.coerce.number().min(0).max(50).default(2),
  /** Fee on an instant withdrawal (no admin review, sent to the gateway right away). Empty = instant withdrawals off. */
  // Missing = 7; present but empty = off. (A preprocess on an optional key never sees a missing key, hence the default.)
  WITHDRAW_INSTANT_FEE_PCT: z
    .string()
    .default('7')
    .transform((v) => (v.trim() === '' ? undefined : Number(v)))
    .pipe(z.number().min(0).max(50).optional()),
  /** Platform margin on the dollar quote, in percent per side (deposit pays more, withdrawal gets less). */
  FX_SPREAD_PCT: z.coerce.number().min(0).max(20).default(0),
  /** Fixed BRL per USD instead of the live quote (development/tests without internet). */
  FX_FIXED_RATE: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().gt(1).lt(20).optional()),
  /** Firebase Storage bucket for KYC photos (e.g. traderoom-48951.firebasestorage.app). Unset: photos stay in Postgres. */
  FIREBASE_STORAGE_BUCKET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(3).optional(),
  ),
  /** Path to the Firebase service account JSON. Unset: Google Application Default Credentials. */
  FIREBASE_CREDENTIALS_FILE: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
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
