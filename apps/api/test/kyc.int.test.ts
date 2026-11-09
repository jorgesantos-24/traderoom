// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { KycSubmitRequest } from '@traderoom/shared';
import { loadConfig } from '../src/config.js';
import { fixedFx } from '../src/lib/fx.js';
import { createPool } from '../src/lib/db.js';
import { createMemoryKycStore } from '../src/lib/kyc-storage.js';
import type { PaymentGateway } from '../src/lib/novus.js';
import { createKycService, sniffImage, type KycService } from '../src/services/kyc.js';
import { createPaymentService } from '../src/services/payments.js';
import { fakeAuth, testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DOMAIN = 'kyc-int.traderoom.test';
const CSRF = 'c'.repeat(43);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
// Valid check digits, generated for tests (not real people).
const CPFS = ['52998224725', '39053344705', '11144477735', '12345678909'];

let pool: pg.Pool;
let kyc: KycService;

async function newUser(role = 'user'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name, role) values ($1, '!', 'Cliente Teste', $2) returning id`,
    [`u-${randomUUID()}@${DOMAIN}`, role],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into accounts (user_id, kind) values ($1, 'real'), ($1, 'demo')`, [id]);
  return id;
}

const form = (o: Partial<KycSubmitRequest> = {}) =>
  ({
    fullName: 'Maria Teste da Silva',
    cpf: '529.982.247-25',
    birthDate: '1990-05-20',
    phone: '(11) 98888-7777',
    zip: '01310-100',
    street: 'Av. Paulista',
    number: '1000',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
    docType: 'RG',
    ...o,
  }) as const;

beforeAll(async () => {
  pool = createPool(loadConfig());
  // Earlier runs may have left these CPFs on test users.
  await pool.query(`update users set cpf = null where email like $1`, [`%@${DOMAIN}`]);
  kyc = createKycService({ pool, now: () => new Date('2026-11-07T12:00:00Z') });
});

afterAll(async () => {
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from admin_audit where admin_id in (${users})`);
  await pool.query(`delete from kyc_submissions where user_id in (${users})`);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.end();
});

describe('KYC service', () => {
  it('detects image types by their bytes', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('needs every photo, an adult and a free CPF; then waits for review', async () => {
    const user = await newUser();
    const { KycSubmitInput } = await import('@traderoom/shared');
    const parse = (o: Partial<KycSubmitRequest> = {}) => KycSubmitInput.parse(form(o));

    await kyc.uploadFile(user, 'doc_front', JPEG);
    await expect(kyc.submit(user, parse())).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('verso') });
    await kyc.uploadFile(user, 'doc_back', PNG);
    await kyc.uploadFile(user, 'selfie', JPEG);
    await expect(kyc.uploadFile(user, 'selfie', Buffer.from('not an image'))).rejects.toMatchObject({ statusCode: 400 });
    await expect(kyc.submit(user, parse({ birthDate: '2010-01-01' }))).rejects.toMatchObject({ statusCode: 400 });

    const s = await kyc.submit(user, parse());
    expect(s).toMatchObject({
      status: 'pending',
      submission: { status: 'pending', cpf: CPFS[0], files: ['doc_back', 'doc_front', 'selfie'] },
    });
    await expect(kyc.uploadFile(user, 'selfie', JPEG)).rejects.toMatchObject({ statusCode: 409 });
    await expect(kyc.requireApproved(user)).rejects.toMatchObject({ statusCode: 403, code: 'kyc_required' });
  });

  it('approval unlocks payments and stores the CPF; one CPF per account', async () => {
    const admin = await newUser('admin');
    const a = await newUser();
    const b = await newUser();
    for (const u of [a, b]) {
      await kyc.uploadFile(u, 'doc_front', JPEG);
      await kyc.uploadFile(u, 'selfie', JPEG);
    }
    const { KycSubmitInput } = await import('@traderoom/shared');
    const sa = await kyc.submit(a, KycSubmitInput.parse(form({ cpf: CPFS[1], docType: 'PASSAPORTE' })));
    await kyc.submit(b, KycSubmitInput.parse(form({ cpf: CPFS[1], docType: 'PASSAPORTE' })));

    const approved = await kyc.approve(admin, sa.submission!.id);
    expect(approved).toMatchObject({ status: 'approved', userId: a });
    await expect(kyc.requireApproved(a)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ cpf: string; kyc_status: string }>('select cpf, kyc_status from users where id = $1', [a]);
    expect(rows[0]).toEqual({ cpf: CPFS[1], kyc_status: 'approved' });

    // b used the same CPF: approving b is refused.
    const list = await kyc.adminList({ status: 'pending', limit: 50 });
    const subB = list.items.find((x) => x.userId === b)!;
    await expect(kyc.approve(admin, subB.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(kyc.approve(admin, sa.submission!.id)).rejects.toMatchObject({ statusCode: 409 });

    // Payments check KYC first.
    const gateway = {} as PaymentGateway;
    const pay = createPaymentService({
      pool,
      gateway,
      postbackUrl: null,
      fx: fixedFx(5),
      requireKyc: (u) => kyc.requireApproved(u),
    });
    await expect(pay.requestWithdrawal(b, { amountCents: 5000, pixKeyType: 'CPF', pixKey: CPFS[1]! })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await pay.info(a)).kycStatus).toBe('approved');
  });

  it('a rejected user sees the reason and can send again', async () => {
    const admin = await newUser('admin');
    const u = await newUser();
    const { KycSubmitInput } = await import('@traderoom/shared');
    await kyc.uploadFile(u, 'doc_front', JPEG);
    await kyc.uploadFile(u, 'doc_back', JPEG);
    await kyc.uploadFile(u, 'selfie', JPEG);
    const s = await kyc.submit(u, KycSubmitInput.parse(form({ cpf: CPFS[2] })));
    await kyc.reject(admin, s.submission!.id, 'Foto do documento ilegível');
    expect(await kyc.state(u)).toMatchObject({
      status: 'rejected',
      submission: { status: 'rejected', rejectReason: 'Foto do documento ilegível' },
    });

    const again = await kyc.uploadFile(u, 'doc_front', JPEG);
    expect(again).toMatchObject({ status: 'rejected', submission: { status: 'draft', files: ['doc_front'] } });
    const { rows } = await pool.query<{ action: string }>(`select action from admin_audit where admin_id = $1`, [admin]);
    expect(rows.map((r) => r.action)).toEqual(['kyc.reject']);
  });
});

describe('KYC routes', () => {
  let app: FastifyInstance;
  let user: string;
  let admin: string;
  beforeAll(async () => {
    user = await newUser();
    admin = await newUser('admin');
    app = await testApp({
      deps: {
        kyc,
        auth: fakeAuth({
          resolveSession: async (v) =>
            v === 'user-sid'
              ? { sessionId: 's1', user: { id: user, email: 'c@x.test', name: 'Cliente', role: 'user' } }
              : v === 'admin-sid'
                ? { sessionId: 's2', user: { id: admin, email: 'a@x.test', name: 'Admin', role: 'admin' } }
                : null,
        }),
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const send = (method: 'GET' | 'PUT' | 'POST', url: string, sid: string, body?: Buffer | object, type = 'application/json') =>
    app.inject({
      method,
      url,
      headers: {
        cookie: `sid=${sid}; __Host-csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        ...(body ? { 'content-type': type } : {}),
      },
      payload: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });

  it('uploads raw photos, submits, and lets only admins see and judge them', async () => {
    expect((await send('PUT', '/api/kyc/files/doc_front', 'user-sid', JPEG, 'image/jpeg')).statusCode).toBe(200);
    expect((await send('PUT', '/api/kyc/files/selfie', 'user-sid', PNG, 'image/png')).statusCode).toBe(200);
    expect((await send('PUT', '/api/kyc/files/passport', 'user-sid', PNG, 'image/png')).statusCode).toBe(400);
    expect((await send('PUT', '/api/kyc/files/selfie', 'user-sid', Buffer.from('x'), 'application/pdf')).statusCode).toBe(415);

    const sub = await send('POST', '/api/kyc/submit', 'user-sid', form({ cpf: CPFS[3], docType: 'PASSAPORTE' }));
    expect(sub.statusCode).toBe(200);
    const id = sub.json<{ submission: { id: string } }>().submission.id;

    expect((await send('GET', '/api/admin/kyc', 'user-sid')).statusCode).toBe(403);
    expect((await send('GET', `/api/admin/kyc/${id}/files/selfie`, 'user-sid')).statusCode).toBe(403);
    const img = await send('GET', `/api/admin/kyc/${id}/files/selfie`, 'admin-sid');
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    const ok = await send('POST', `/api/admin/kyc/${id}/approve`, 'admin-sid', {});
    expect(ok.json()).toMatchObject({ submission: { status: 'approved' } });
    expect((await send('GET', '/api/kyc', 'user-sid')).json()).toMatchObject({ status: 'approved' });
  });
});

describe('KYC photos in object storage (Firebase)', () => {
  it('keeps only the path in Postgres, serves the bytes back and cleans up replaced photos', async () => {
    const blobs = createMemoryKycStore();
    const svc = createKycService({ pool, blobs, now: () => new Date('2026-11-07T12:00:00Z') });
    const admin = await newUser('admin');
    const user = await newUser();

    await svc.uploadFile(user, 'doc_front', JPEG);
    await svc.uploadFile(user, 'doc_back', PNG);
    await svc.uploadFile(user, 'selfie', PNG);
    await svc.uploadFile(user, 'selfie', JPEG); // replaces the first selfie
    await new Promise((r) => setTimeout(r, 10)); // deletes are fire-and-forget
    expect(blobs.objects.size).toBe(3);
    for (const [path] of blobs.objects)
      expect(path).toMatch(new RegExp(`^kyc/${user}/[0-9a-f-]{36}/(doc_front|doc_back|selfie)-[0-9a-f-]{36}$`));

    const { KycSubmitInput } = await import('@traderoom/shared');
    const s = await svc.submit(user, KycSubmitInput.parse(form({ cpf: '287.654.319-28', docType: 'PASSAPORTE' })));
    await new Promise((r) => setTimeout(r, 10));
    expect(blobs.objects.size).toBe(2); // passport: the stray back was dropped

    const { rows } = await pool.query<{ kind: string; data: Buffer | null; storage_path: string | null }>(
      'select kind, data, storage_path from kyc_files where submission_id = $1 order by kind',
      [s.submission!.id],
    );
    expect(rows.map((r) => [r.kind, r.data, typeof r.storage_path])).toEqual([
      ['doc_front', null, 'string'],
      ['selfie', null, 'string'],
    ]);
    await expect(svc.adminFile(s.submission!.id, 'selfie')).resolves.toEqual({ mime: 'image/jpeg', data: JPEG });
    await svc.reject(admin, s.submission!.id, 'Foto ilegível');
  });

  it('removes the uploaded object when the database write fails', async () => {
    const blobs = createMemoryKycStore();
    const svc = createKycService({ pool, blobs });
    const user = await newUser();
    await pool.query(`update users set kyc_status = 'approved' where id = $1`, [user]);
    await expect(svc.uploadFile(user, 'selfie', JPEG)).rejects.toMatchObject({ statusCode: 409 });
    expect(blobs.objects.size).toBe(0);
  });
});
