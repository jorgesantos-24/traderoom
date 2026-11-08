import { RedisKeys, Registry } from '@traderoom/shared';
import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './lib/db.js';
import { createKlinesFetcher } from './lib/binance.js';
import { redisCache } from './lib/cache.js';
import { createConsoleMailer, createNullMailer, createResendMailer } from './lib/mailer.js';
import { createRedis } from './lib/redis.js';
import { createAssetRepo } from './services/assets.js';
import { createAuthService } from './services/auth.js';
import { createCandleService } from './services/candles.js';
import { createOtcCandleSource } from './services/otc-candles.js';
import { createOrderLimitsRepo } from './services/order-limits.js';
import { createAdminService } from './services/admin.js';
import { createOrderService, redisDueScheduler, redisPriceReader } from './services/orders.js';
import { createWalletService } from './services/wallet.js';
import { awesomeApi, binanceUsdtBrl, createFxService, fixedFx, openErApi } from './lib/fx.js';
import { createNovusGateway } from './lib/novus.js';
import { createPaymentService } from './services/payments.js';
import { WEBHOOK_PATH } from './routes/payments.js';
import { createKycService } from './services/kyc.js';
import { createFirebaseKycStore } from './lib/kyc-storage.js';
import { createOtcOverrideService } from './services/otc-override.js';

const config = loadConfig();
const pool = createPool(config);
const redis = createRedis(config);
const metrics = new Registry();
metrics.gauge('process_resident_memory_bytes', 'Resident memory of the api process.', () => [[{}, process.memoryUsage().rss]]);
const binanceResponses = metrics.counter('binance_rest_responses_total', 'Binance REST (klines) responses, by HTTP status.');
const assets = createAssetRepo(pool);
const kycBlobs = config.FIREBASE_STORAGE_BUCKET
  ? await createFirebaseKycStore({ bucket: config.FIREBASE_STORAGE_BUCKET, credentialsFile: config.FIREBASE_CREDENTIALS_FILE })
  : null;
const kyc = createKycService({ pool, blobs: kycBlobs });
const limits = createOrderLimitsRepo(pool);
// Set once the app (and its logger) exists.
let logScheduleError: (err: unknown, orderId: string) => void = () => {};
let logFxError: (err: unknown) => void = () => {};
// Balances are in dollars; Pix moves reais at this quote.
const fx = config.FX_FIXED_RATE
  ? fixedFx(config.FX_FIXED_RATE)
  : createFxService({
      sources: [awesomeApi, openErApi, binanceUsdtBrl(config.BINANCE_REST_URL)],
      spreadPct: config.FX_SPREAD_PCT,
      onError: (err) => logFxError(err),
    });

const app = await buildApp(
  {
    health: {
      pingPostgres: async () => {
        await pool.query('select 1');
      },
      pingRedis: async () => {
        await redis.ping();
      },
      getLastTickMs: async () => {
        const v = await redis.get(RedisKeys.feedLastTickMs);
        return v === null ? null : Number(v);
      },
      now: () => Date.now(),
      feedMaxAgeMs: config.HEALTH_FEED_MAX_AGE_MS,
      timeoutMs: 1000,
    },
    auth: createAuthService(pool),
    createMailer: (log) =>
      config.NODE_ENV === 'development'
        ? createConsoleMailer(log)
        : config.RESEND_API_KEY
          ? createResendMailer(log, { apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM })
          : createNullMailer(log),
    createCandles: (log) =>
      createCandleService({
        cache: redisCache(redis),
        fetchKlines: createKlinesFetcher(config.BINANCE_REST_URL, {
          // Acceptance: zero 429/418 from Binance. Watch this series in production.
          onStatus: (status) => binanceResponses.inc({ status: String(status) }),
        }),
        assets,
        otc: createOtcCandleSource(pool, assets),
        log,
      }),
    orders: createOrderService({
      pool,
      prices: redisPriceReader(redis),
      scheduler: redisDueScheduler(redis),
      assets,
      limits,
      staleMs: config.FEED_STALE_MS,
      entryDelayMs: config.ORDER_ENTRY_DELAY_MS,
      onScheduleError: (err, orderId) => logScheduleError(err, orderId),
    }),
    wallet: createWalletService(pool),
    assets,
    limits,
    admin: createAdminService({ pool, onAssetsChanged: () => assets.invalidate() }),
    payments: createPaymentService({
      pool,
      gateway: config.NOVUS_API_KEY ? createNovusGateway({ apiKey: config.NOVUS_API_KEY, baseUrl: config.NOVUS_API_URL }) : null,
      webhookSecrets: [config.NOVUS_API_KEY, config.NOVUS_WEBHOOK_SECRET].filter((s): s is string => Boolean(s)),
      postbackUrl: config.NOVUS_POSTBACKS ? `${config.PUBLIC_ORIGIN}${WEBHOOK_PATH}` : null,
      requireKyc: (userId) => kyc.requireApproved(userId),
      fx,
    }),
    kyc,
    otcOverride: createOtcOverrideService({ pool, redis }),
    metrics,
  },
  {
    logger: loggerOptions(config.LOG_LEVEL),
    publicOrigin: config.PUBLIC_ORIGIN,
    // The trading screen's timeframes; switching charts then reads Redis, not Binance.
    warmCandleIntervals: ['1m', '5m', '15m', '1h'],
    security: {
      cookieSecure: config.COOKIE_SECURE,
      rateLimit: { redis, nameSpace: 'rl:', globalMax: config.RATE_LIMIT_GLOBAL_PER_MIN },
    },
  },
);

logScheduleError = (err, orderId) =>
  app.log.error({ err, orderId }, 'failed to schedule order settlement; the worker sweep will pick it up');
logFxError = (err) => app.log.warn({ err }, 'dollar quote source failed; trying the next one');
pool.on('error', (err) => app.log.error({ err }, 'postgres pool error'));
redis.on('error', (err) => app.log.error({ err }, 'redis error'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
