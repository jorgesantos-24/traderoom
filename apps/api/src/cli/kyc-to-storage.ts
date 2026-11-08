/**
 * Moves KYC photos still stored in Postgres (kyc_files.data) into Firebase Storage.
 *
 *   npm run kyc:to-storage -w @traderoom/api            # dry run: counts only
 *   npm run kyc:to-storage -w @traderoom/api -- --apply
 *
 * Needs DATABASE_URL and FIREBASE_STORAGE_BUCKET (+ FIREBASE_CREDENTIALS_FILE outside GCP).
 * Each photo is uploaded first, then its row switches to the path; a photo replaced meanwhile
 * is left alone and its upload removed. Safe to run again.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { createFirebaseKycStore } from '../lib/kyc-storage.js';

const env = z
  .object({
    DATABASE_URL: z.url(),
    FIREBASE_STORAGE_BUCKET: z.string().min(3),
    FIREBASE_CREDENTIALS_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  })
  .parse(process.env);
const apply = process.argv.includes('--apply');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
try {
  const { rows: count } = await pool.query<{ n: string; bytes: string | null }>(
    'select count(*)::text as n, sum(size_bytes)::text as bytes from kyc_files where data is not null',
  );
  const total = Number(count[0]?.n ?? 0);
  console.log(`${total} photo(s) in Postgres, ${Math.round(Number(count[0]?.bytes ?? 0) / 1024)} KiB`);
  if (!apply || total === 0) {
    if (!apply && total > 0) console.log('dry run; pass --apply to move them');
    process.exit(0);
  }

  const blobs = await createFirebaseKycStore({ bucket: env.FIREBASE_STORAGE_BUCKET, credentialsFile: env.FIREBASE_CREDENTIALS_FILE });
  let moved = 0;
  for (;;) {
    const { rows } = await pool.query<{
      submission_id: string;
      user_id: string;
      kind: string;
      mime: string;
      data: Buffer;
      created_at: Date;
    }>(
      `select f.submission_id, s.user_id, f.kind, f.mime, f.data, f.created_at
         from kyc_files f join kyc_submissions s on s.id = f.submission_id
        where f.data is not null limit 20`,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const path = `kyc/${r.user_id}/${r.submission_id}/${r.kind}-${randomUUID()}`;
      await blobs.put(path, r.data, r.mime);
      // Only if the row is still the photo we uploaded.
      const upd = await pool.query(
        `update kyc_files set storage_path = $3, data = null
          where submission_id = $1 and kind = $2 and data is not null and created_at = $4`,
        [r.submission_id, r.kind, path, r.created_at],
      );
      if (upd.rowCount === 1) moved++;
      else await blobs.delete(path);
    }
    console.log(`moved ${moved}/${total}`);
  }
  console.log(`done: ${moved} photo(s) now in gs://${env.FIREBASE_STORAGE_BUCKET}`);
} finally {
  await pool.end();
}
