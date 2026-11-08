/**
 * Local tunnel to the Cloud SQL (Firebase SQL Connect) Postgres instance.
 *
 *   npm run db:tunnel
 *
 * Listens on 127.0.0.1:CLOUD_SQL_LOCAL_PORT (default 5433) and forwards each connection over the
 * Cloud SQL connector (TLS + IAM authorization with the service account). Everything else (api,
 * worker, ws, migrations, tests) keeps using a plain DATABASE_URL pointing at that port, e.g.
 *   DATABASE_URL=postgres://postgres:<senha>@127.0.0.1:5433/traderoom-48951-database
 *
 * The service account needs the "Cloud SQL Client" role, and the Cloud SQL Admin API must be on.
 */
import { createServer, type Socket } from 'node:net';
import { AuthTypes, Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

const env = z
  .object({
    /** project:region:instance, e.g. traderoom-48951:southamerica-east1:traderoom-48951-instance */
    CLOUD_SQL_INSTANCE: z.string().regex(/^[^:]+:[^:]+:[^:]+$/, 'use project:region:instance'),
    CLOUD_SQL_LOCAL_PORT: z.coerce.number().int().min(1).max(65535).default(5433),
    FIREBASE_CREDENTIALS_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  })
  .parse(process.env);

const auth = new GoogleAuth({
  ...(env.FIREBASE_CREDENTIALS_FILE ? { keyFile: env.FIREBASE_CREDENTIALS_FILE } : {}),
  scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
});
const connector = new Connector({ auth });
const { stream } = await connector.getOptions({
  instanceConnectionName: env.CLOUD_SQL_INSTANCE,
  ipType: IpAddressTypes.PUBLIC,
  authType: AuthTypes.PASSWORD,
});

const open = new Set<Socket>();
const server = createServer((local) => {
  const remote = stream();
  open.add(local);
  const close = () => {
    open.delete(local);
    local.destroy();
    remote.destroy();
  };
  local.on('error', close).on('close', close);
  remote.on('error', (err) => {
    console.error(`cloud sql: ${err.message}`);
    close();
  });
  remote.on('close', close);
  local.pipe(remote).pipe(local);
});

server.listen(env.CLOUD_SQL_LOCAL_PORT, '127.0.0.1', () => {
  console.log(`cloud sql tunnel: 127.0.0.1:${env.CLOUD_SQL_LOCAL_PORT} -> ${env.CLOUD_SQL_INSTANCE}`);
});

const shutdown = () => {
  server.close();
  for (const s of open) s.destroy();
  connector.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
