import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { z } from 'zod';

// Same depth from src/cli and dist/cli, so this works in dev and prod.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));

const Args = z.tuple([z.enum(['up', 'down']), z.coerce.number().int().positive().optional()]);

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env['DATABASE_URL']);
  const [direction, count] = Args.parse(process.argv.slice(2));

  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    // Down defaults to a single step so a typo cannot wipe the schema.
    count: count ?? (direction === 'down' ? 1 : Infinity),
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
  });

  console.log(
    applied.length === 0
      ? 'No migrations to run.'
      : `Ran ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
