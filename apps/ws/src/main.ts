import { loadConfig } from './config.js';
import { RELAY_DEFAULTS, Relay } from './feed/relay.js';
import { insertSnapshots, lastPrice, loadEnabledAssets, writePricesToRedis } from './feed/sinks.js';
import { GATEWAY_DEFAULTS, Gateway } from './gateway/gateway.js';
import { createSessionStore } from './gateway/session.js';
import { createHttpServer } from './http.js';
import { createPool } from './lib/db.js';
import { createLogger } from './lib/log.js';
import { Registry } from './lib/metrics.js';
import { createRedis } from './lib/redis.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, config.WS_DATABASE_POOL_MAX);
const redis = createRedis(config.REDIS_URL);
const metrics = new Registry();
metrics.gauge('process_resident_memory_bytes', 'Resident memory of the ws process.', () => [[{}, process.memoryUsage().rss]]);
metrics.gauge('nodejs_heap_used_bytes', 'V8 heap in use.', () => [[{}, process.memoryUsage().heapUsed]]);

pool.on('error', (err) => log.error({ err }, 'postgres pool error'));
redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));

const relay = new Relay(
  {
    ...RELAY_DEFAULTS,
    staleMs: config.FEED_STALE_MS,
    binanceUrl: config.BINANCE_WS_URL,
    binanceBackupUrl: config.BINANCE_BACKUP_WS_URL,
  },
  {
    log,
    metrics,
    sinks: {
      writePrices: (ticks) => writePricesToRedis(redis, ticks),
      writeSnapshots: (rows) => insertSnapshots(pool, rows),
      lastPrice: (id) => lastPrice(pool, id),
      loadAssets: async () => {
        const { assets, invalid } = await loadEnabledAssets(pool);
        if (invalid.length > 0) log.error({ invalid }, 'skipping assets with malformed symbol, binance_stream or OTC settings');
        return assets;
      },
    },
  },
);

const server = createHttpServer({ metrics, relay });
const gateway = new Gateway(
  server,
  relay,
  createSessionStore(pool),
  { ...GATEWAY_DEFAULTS, allowedOrigin: config.PUBLIC_ORIGIN },
  { log, metrics },
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  try {
    // Clients first (1001 tells them to reconnect), then upstream feeds.
    await gateway.close();
    await relay.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await relay.start();
await new Promise<void>((resolve) => server.listen(config.WS_PORT, config.WS_HOST, resolve));
log.info({ host: config.WS_HOST, port: config.WS_PORT }, 'ws process listening');
