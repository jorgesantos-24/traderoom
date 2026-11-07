import { createServer, type Server } from 'node:http';
import type { Registry } from './lib/metrics.js';
import type { Relay } from './feed/relay.js';

/**
 * HTTP server of the ws process. The gateway handles the `/ws` upgrade on it;
 * `/metrics` and `/healthz` are internal and Caddy must only expose `/ws`.
 */
export function createHttpServer(deps: { metrics: Registry; relay: Relay; now?: () => number }): Server {
  const now = deps.now ?? Date.now;
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      res.end(deps.metrics.render());
      return;
    }
    if (path === '/healthz') {
      const last = deps.relay.lastTickMs();
      const body = {
        ok: true,
        lastTickAgeMs: last === null ? null : now() - last,
        assets: deps.relay.assets().map((a) => ({
          symbol: a.symbol,
          stale: deps.relay.isStale(a.symbol),
          source: deps.relay.sourceOf(a.symbol),
        })),
      };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Recurso não encontrado.' } }));
  });
}
