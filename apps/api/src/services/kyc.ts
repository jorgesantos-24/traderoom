import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ageOn,
  ErrorCode,
  KYC_MAX_FILE_BYTES,
  KYC_MIN_AGE,
  requiredKycFiles,
  type AdminKycQuery,
  type AdminKycView,
  type KycDocType,
  type KycFileKind,
  type KycStateView,
  type KycStatus,
  type KycSubmissionView,
  type KycSubmitInput,
  type Page,
} from '@traderoom/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { inTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import type { KycBlobStore } from '../lib/kyc-storage.js';
import { isoUs } from './orders.js';

export interface KycService {
  state(userId: string): Promise<KycStateView>;
  uploadFile(userId: string, kind: KycFileKind, data: Buffer): Promise<KycStateView>;
  submit(userId: string, input: KycSubmitInput): Promise<KycStateView>;
  /** Throws 403 kyc_required unless the user's identity is approved. */
  requireApproved(userId: string): Promise<void>;
  adminList(q: AdminKycQuery): Promise<Page<AdminKycView>>;
  adminGet(id: string): Promise<AdminKycView>;
  adminFile(id: string, kind: KycFileKind): Promise<{ mime: string; data: Buffer }>;
  approve(adminId: string, id: string): Promise<AdminKycView>;
  reject(adminId: string, id: string, reason: string): Promise<AdminKycView>;
}

/** Image type from the first bytes; the declared content type is not trusted. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

interface SubRow {
  id: string;
  user_id: string;
  status: KycSubmissionView['status'];
  full_name: string | null;
  cpf: string | null;
  birth_date: string | null;
  phone: string | null;
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
  doc_type: KycDocType | null;
  reject_reason: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  files: KycFileKind[] | null;
  email?: string;
  name?: string;
}

const SUB_COLS = `s.id, s.user_id, s.status, s.full_name, s.cpf, to_char(s.birth_date, 'YYYY-MM-DD') as birth_date, s.phone,
  s.address_zip, s.address_street, s.address_number, s.address_complement, s.address_district, s.address_city, s.address_state,
  s.doc_type, s.reject_reason, ${isoUs('s.submitted_at')} as submitted_at, ${isoUs('s.reviewed_at')} as reviewed_at,
  ${isoUs('s.created_at')} as created_at,
  (select array_agg(f.kind order by f.kind) from kyc_files f where f.submission_id = s.id) as files`;

const toView = (r: SubRow): KycSubmissionView => ({
  id: r.id,
  status: r.status,
  fullName: r.full_name,
  cpf: r.cpf,
  birthDate: r.birth_date,
  phone: r.phone,
  zip: r.address_zip,
  street: r.address_street,
  number: r.address_number,
  complement: r.address_complement,
  district: r.address_district,
  city: r.address_city,
  state: r.address_state,
  docType: r.doc_type,
  files: r.files ?? [],
  rejectReason: r.reject_reason,
  submittedAt: r.submitted_at,
  reviewedAt: r.reviewed_at,
});

const toAdmin = (r: SubRow): AdminKycView => ({
  ...toView(r),
  userId: r.user_id,
  userEmail: r.email ?? '',
  userName: r.name ?? '',
  createdAt: r.created_at,
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export function createKycService(deps: { pool: pg.Pool; now?: () => Date; blobs?: KycBlobStore | null }): KycService {
  const { pool } = deps;
  const blobs = deps.blobs ?? null;
  /** Old objects are removed only after the row stops pointing at them. */
  const dropBlobs = (paths: ReadonlyArray<string | null | undefined>) => {
    if (!blobs) return;
    for (const p of paths) if (p) void blobs.delete(p).catch(() => undefined);
  };
  const now = deps.now ?? (() => new Date());

  async function latest(db: pg.Pool | pg.PoolClient, userId: string): Promise<SubRow | null> {
    // The open one (draft/pending) if any, else the newest.
    const { rows } = await db.query<SubRow>(
      `select ${SUB_COLS} from kyc_submissions s where s.user_id = $1
        order by (s.status in ('draft', 'pending')) desc, s.created_at desc limit 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async function state(db: pg.Pool | pg.PoolClient, userId: string): Promise<KycStateView> {
    const u = await db.query<{ kyc_status: KycStatus }>('select kyc_status from users where id = $1', [userId]);
    const sub = await latest(db, userId);
    return { status: u.rows[0]?.kyc_status ?? 'none', submission: sub ? toView(sub) : null };
  }

  async function adminRow(db: pg.Pool | pg.PoolClient, id: string): Promise<SubRow> {
    const { rows } = await db.query<SubRow>(
      `select ${SUB_COLS}, u.email::text as email, u.name from kyc_submissions s join users u on u.id = s.user_id where s.id = $1`,
      [id],
    );
    if (!rows[0]) throw new AppError(404, ErrorCode.NotFound, 'Verificação não encontrada.');
    return rows[0];
  }

  /** The user's draft, created on first use. Refuses while a review is pending or after approval. */
  async function draftFor(c: pg.PoolClient, userId: string): Promise<string> {
    const u = await c.query<{ kyc_status: KycStatus }>('select kyc_status from users where id = $1 for update', [userId]);
    const status = u.rows[0]?.kyc_status;
    if (status === 'approved') throw new AppError(409, ErrorCode.Conflict, 'Sua conta já está verificada.');
    if (status === 'pending') throw new AppError(409, ErrorCode.Conflict, 'Sua verificação já está em análise.');
    const d = await c.query<{ id: string }>(`select id from kyc_submissions where user_id = $1 and status = 'draft'`, [userId]);
    if (d.rows[0]) return d.rows[0].id;
    const ins = await c.query<{ id: string }>('insert into kyc_submissions (user_id) values ($1) returning id', [userId]);
    return ins.rows[0]!.id;
  }

  async function audit(c: pg.PoolClient, adminId: string, action: string, payload: Record<string, unknown>) {
    await c.query('insert into admin_audit (admin_id, action, payload) values ($1, $2, $3)', [adminId, action, JSON.stringify(payload)]);
  }

  return {
    state: (userId) => state(pool, userId),

    async uploadFile(userId, kind, data) {
      if (data.length === 0) throw new AppError(400, ErrorCode.ValidationFailed, 'Arquivo vazio.');
      if (data.length > KYC_MAX_FILE_BYTES) throw new AppError(413, ErrorCode.PayloadTooLarge, 'Imagem muito grande (máximo 5 MB).');
      const mime = sniffImage(data);
      if (!mime) throw new AppError(400, ErrorCode.ValidationFailed, 'Envie uma foto em JPG, PNG ou WEBP.');
      let uploaded: string | null = null;
      let replaced: string | null = null;
      try {
        const view = await inTransaction(pool, async (c) => {
          const id = await draftFor(c, userId);
          let path: string | null = null;
          if (blobs) {
            const prev = await c.query<{ storage_path: string | null }>(
              'select storage_path from kyc_files where submission_id = $1 and kind = $2',
              [id, kind],
            );
            replaced = prev.rows[0]?.storage_path ?? null;
            path = `kyc/${userId}/${id}/${kind}-${randomUUID()}`;
            await blobs.put(path, data, mime);
            uploaded = path;
          }
          await c.query(
            `insert into kyc_files (submission_id, kind, mime, data, storage_path, size_bytes) values ($1, $2, $3, $4, $5, $6)
             on conflict (submission_id, kind) do update set mime = excluded.mime, data = excluded.data,
               storage_path = excluded.storage_path, size_bytes = excluded.size_bytes, created_at = now()`,
            [id, kind, mime, path ? null : data, path, data.length],
          );
          return state(c, userId);
        });
        dropBlobs([replaced]);
        return view;
      } catch (err) {
        dropBlobs([uploaded]);
        throw err;
      }
    },

    async submit(userId, input) {
      if (ageOn(input.birthDate, now()) < KYC_MIN_AGE) {
        throw new AppError(400, ErrorCode.ValidationFailed, `birthDate: é preciso ter ${KYC_MIN_AGE} anos ou mais.`);
      }
      if (ageOn(input.birthDate, now()) > 120)
        throw new AppError(400, ErrorCode.ValidationFailed, 'birthDate: data de nascimento inválida.');
      const dropped: string[] = [];
      const view = await inTransaction(pool, async (c) => {
        const id = await draftFor(c, userId);
        const files = await c.query<{ kind: KycFileKind }>('select kind from kyc_files where submission_id = $1', [id]);
        const have = new Set(files.rows.map((r) => r.kind));
        const missing = requiredKycFiles(input.docType).filter((k) => !have.has(k));
        if (missing.length > 0) {
          const names = { doc_front: 'frente do documento', doc_back: 'verso do documento', selfie: 'selfie com o documento' };
          throw new AppError(400, ErrorCode.ValidationFailed, `Falta enviar: ${missing.map((k) => names[k]).join(', ')}.`);
        }
        const other = await c.query('select 1 from users where cpf = $1 and id <> $2', [input.cpf, userId]);
        if (other.rowCount) throw new AppError(409, ErrorCode.Conflict, 'cpf: este CPF já está vinculado a outra conta.');
        const own = await c.query<{ cpf: string | null }>('select cpf from users where id = $1', [userId]);
        const onFile = own.rows[0]?.cpf;
        if (onFile && onFile !== input.cpf) {
          throw new AppError(400, ErrorCode.ValidationFailed, 'cpf: o CPF difere do já usado nos seus depósitos.');
        }
        // A passport has no back: drop a stray one so the reviewer sees only what applies.
        if (input.docType === 'PASSAPORTE') {
          const del = await c.query<{ storage_path: string | null }>(
            `delete from kyc_files where submission_id = $1 and kind = 'doc_back' returning storage_path`,
            [id],
          );
          for (const r of del.rows) if (r.storage_path) dropped.push(r.storage_path);
        }
        await c.query(
          `update kyc_submissions set status = 'pending', full_name = $2, cpf = $3, birth_date = $4, phone = $5,
             address_zip = $6, address_street = $7, address_number = $8, address_complement = $9, address_district = $10,
             address_city = $11, address_state = $12, doc_type = $13, submitted_at = now()
           where id = $1`,
          [
            id,
            input.fullName,
            input.cpf,
            input.birthDate,
            input.phone,
            input.zip,
            input.street,
            input.number,
            input.complement || null,
            input.district,
            input.city,
            input.state,
            input.docType,
          ],
        );
        await c.query(`update users set kyc_status = 'pending' where id = $1`, [userId]);
        return state(c, userId);
      });
      dropBlobs(dropped);
      return view;
    },

    async requireApproved(userId) {
      const { rows } = await pool.query<{ kyc_status: KycStatus }>('select kyc_status from users where id = $1', [userId]);
      const s = rows[0]?.kyc_status ?? 'none';
      if (s === 'approved') return;
      const msg =
        s === 'pending'
          ? 'Sua verificação de identidade está em análise. Depósitos e saques liberam assim que for aprovada.'
          : 'Verifique sua identidade para depositar e sacar.';
      throw new AppError(403, ErrorCode.KycRequired, msg);
    },

    async adminList(q) {
      const cursor = decodeCursor(q.cursor);
      const { rows } = await pool.query<SubRow & { cursor_at: string }>(
        `select ${SUB_COLS}, u.email::text as email, u.name, ${isoUs('s.created_at')} as cursor_at
           from kyc_submissions s join users u on u.id = s.user_id
          where (($1 = 'pending' and s.status = 'pending') or ($1 = 'all' and s.status <> 'draft'))
            and ($2::timestamptz is null or (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
          order by s.created_at desc, s.id desc
          limit $4`,
        [q.status, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toAdmin),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
      };
    },

    async adminGet(id) {
      return toAdmin(await adminRow(pool, id));
    },

    async adminFile(id, kind) {
      const { rows } = await pool.query<{ mime: string; data: Buffer | null; storage_path: string | null }>(
        'select mime, data, storage_path from kyc_files where submission_id = $1 and kind = $2',
        [id, kind],
      );
      const f = rows[0];
      if (!f) throw new AppError(404, ErrorCode.NotFound, 'Imagem não encontrada.');
      if (f.data) return { mime: f.mime, data: f.data };
      if (!blobs || !f.storage_path) throw new AppError(503, ErrorCode.Unavailable, 'Armazenamento de imagens indisponível.');
      return { mime: f.mime, data: await blobs.get(f.storage_path) };
    },

    async approve(adminId, id) {
      try {
        await inTransaction(pool, async (c) => {
          const { rows } = await c.query<{ user_id: string; status: string; cpf: string; email: string }>(
            'select k.user_id, k.status, k.cpf, u.email from kyc_submissions k join users u on u.id = k.user_id where k.id = $1 for update of k',
            [id],
          );
          const s = rows[0];
          if (!s) throw new AppError(404, ErrorCode.NotFound, 'Verificação não encontrada.');
          if (s.status !== 'pending') throw new AppError(409, ErrorCode.Conflict, 'Esta verificação já foi analisada.');
          await c.query(`update kyc_submissions set status = 'approved', reviewed_by = $2, reviewed_at = now() where id = $1`, [
            id,
            adminId,
          ]);
          await c.query(`update users set kyc_status = 'approved', cpf = $2 where id = $1`, [s.user_id, s.cpf]);
          await audit(c, adminId, 'kyc.approve', { submissionId: id, userId: s.user_id, email: s.email });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, ErrorCode.Conflict, 'Este CPF já está aprovado em outra conta.');
        throw err;
      }
      return toAdmin(await adminRow(pool, id));
    },

    async reject(adminId, id, reason) {
      await inTransaction(pool, async (c) => {
        const { rows } = await c.query<{ user_id: string; status: string; email: string }>(
          'select k.user_id, k.status, u.email from kyc_submissions k join users u on u.id = k.user_id where k.id = $1 for update of k',
          [id],
        );
        const s = rows[0];
        if (!s) throw new AppError(404, ErrorCode.NotFound, 'Verificação não encontrada.');
        if (s.status !== 'pending') throw new AppError(409, ErrorCode.Conflict, 'Esta verificação já foi analisada.');
        await c.query(
          `update kyc_submissions set status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() where id = $1`,
          [id, reason, adminId],
        );
        await c.query(`update users set kyc_status = 'rejected' where id = $1`, [s.user_id]);
        await audit(c, adminId, 'kyc.reject', { submissionId: id, userId: s.user_id, email: s.email, reason });
      });
      return toAdmin(await adminRow(pool, id));
    },
  };
}
