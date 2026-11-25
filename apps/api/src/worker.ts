// Settlement worker process (systemd unit `worker`). Internal HTTP: /metrics and /healthz.
import { createServer } from 'node:http';
import { pino } from 'pino';
import { z } from 'zod';
import { Registry } from '@traderoom/shared';
import { createPool } from './lib/db.js';
import { createRedis } from './lib/redis.js';
import { redisDueQueue, SettlementWorker, WORKER_DEFAULTS } from './worker/settlement-worker.js';
import { RETENTION_DEFAULTS, SnapshotRetention } from './worker/snapshot-retention.js';
import { createTelegram } from './lib/telegram.js';
import { M1_ROOM, SIGNAL_DEFAULTS, TelegramSignals } from './worker/telegram-signals.js';

const Env = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  WORKER_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(6),
  REDIS_URL: z.url(),
  WORKER_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  // Telegram signals channel: off unless both are set.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHANNEL_ID: z.string().min(1).optional(),
  TELEGRAM_SIGNAL_SYMBOLS: z.string().min(1).optional(),
  TELEGRAM_SIGNAL_GALES: z.coerce.number().int().min(0).max(3).default(SIGNAL_DEFAULTS.gales),
  TELEGRAM_SIGNUP_URL: z.url().optional(),
  PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
});
const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}
const env = parsed.data;

const log = pino({ level: env.LOG_LEVEL, base: { svc: 'worker' } });
const pool = createPool({ DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.WORKER_DATABASE_POOL_MAX });
const redis = createRedis({ REDIS_URL: env.REDIS_URL });
pool.on('error', (err) => log.error({ err }, 'postgres pool error'));
redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));

const metrics = new Registry();
metrics.gauge('process_resident_memory_bytes', 'Resident memory of the worker process.', () => [[{}, process.memoryUsage().rss]]);
const worker = new SettlementWorker({ pool, queue: redisDueQueue(redis), log, metrics }, WORKER_DEFAULTS);
const retention = new SnapshotRetention({ pool, log, metrics }, { ...RETENTION_DEFAULTS, retentionDays: env.SNAPSHOT_RETENTION_DAYS });
const signalCommon = {
  symbols: env.TELEGRAM_SIGNAL_SYMBOLS?.split(',').map((x) => x.trim()).filter(Boolean) ?? SIGNAL_DEFAULTS.symbols,
  links: { signupUrl: env.TELEGRAM_SIGNUP_URL ?? `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/register` },
  publicOrigin: env.PUBLIC_ORIGIN,
};
// One instance per chat, same bot: the main channel (M5) and the "SALA DE SINAIS M1" group.
const signalRooms =
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID
    ? [
        new TelegramSignals(
          { pool, telegram: createTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHANNEL_ID }), log, metrics },
          { ...SIGNAL_DEFAULTS, ...signalCommon, gales: env.TELEGRAM_SIGNAL_GALES },
        ),
        new TelegramSignals(
          { pool, telegram: createTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: M1_ROOM.chatId }), log, metrics },
          { ...M1_ROOM.options, ...signalCommon },
        ),
      ]
    : [];

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(metrics.render());
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    const last = worker.lastRound;
    // Healthy while rounds keep completing (a round runs every 250 ms).
    const ok = last !== null && Date.now() - last < 10_000;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, lastRoundAgeMs: last === null ? null : Date.now() - last }));
    return;
  }
  res.writeHead(404).end();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  retention.stop();
  for (const s of signalRooms) s.stop();
  await worker.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.start();
retention.start();
for (const s of signalRooms) s.start();
log.info({ telegramSignals: signalRooms.length > 0, rooms: signalRooms.length }, 'telegram signals');
await new Promise<void>((r) => server.listen(env.WORKER_PORT, env.WORKER_HOST, r));
log.info({ host: env.WORKER_HOST, port: env.WORKER_PORT }, 'settlement worker running');
