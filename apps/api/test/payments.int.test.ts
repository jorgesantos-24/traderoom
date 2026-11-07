// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { GatewayError, type ChargeRequest, type PaymentGateway, type PayoutRequest, type PayoutState } from '../src/lib/novus.js';
import { WEBHOOK_PATH } from '../src/routes/payments.js';
import { createPaymentService, type PaymentService } from '../src/services/payments.js';
import { testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DOMAIN = 'payments-int.traderoom.test';
const KEY = 'test-private-key';
const VALID_CPF = '52998224725';

/** A CPF with valid check digits that no other test user has (CPFs are unique per account). */
function freshCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (digits: number[]) => {
    const sum = digits.reduce((s, d, i) => s + d * (digits.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  base.push(dv(base));
  base.push(dv(base));
  return base.join('');
}

let pool: pg.Pool;

/** In-memory stand-in for Novus. */
class FakeGateway implements PaymentGateway {
  charges: ChargeRequest[] = [];
  payouts: PayoutRequest[] = [];
  chargeStatus = new Map<string, string>();
  failNextPayout = false;
  async createPixCharge(req: ChargeRequest) {
    this.charges.push(req);
    const providerId = `inv-${req.externalId}`;
    this.chargeStatus.set(providerId, 'pending');
    return { providerId, pixCode: '00020126PIXCODE', expiresAt: null, status: 'pending' };
  }
  async getCharge(providerId: string) {
    return { providerId, externalId: null, status: this.chargeStatus.get(providerId) ?? 'pending', amountCents: null };
  }
  async createPayout(req: PayoutRequest): Promise<PayoutState> {
    if (this.failNextPayout) {
      this.failNextPayout = false;
      throw new GatewayError('Novus respondeu 500: indisponível', 500);
    }
    this.payouts.push(req);
    return { providerId: `po-${req.externalId}`, externalId: req.externalId, status: 'pending', amountCents: req.amountCents, refundedAmountCents: null };
  }
  async getPayout(providerId: string): Promise<PayoutState> {
    return { providerId, externalId: null, status: 'completed', amountCents: null, refundedAmountCents: null };
  }
}

let gw: FakeGateway;
let svc: PaymentService;

async function newUser(realCents = 0, role = 'user'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, name, role) values ($1, '!', 'Pagador Teste', $2) returning id`,
    [`u-${randomUUID()}@${DOMAIN}`, role],
  );
  const id = rows[0]!.id;
  await pool.query(`insert into accounts (user_id, kind, balance_cents) values ($1, 'real', $2), ($1, 'demo', 1000000)`, [id, realCents]);
  return id;
}

async function real(userId: string): Promise<number> {
  const { rows } = await pool.query<{ b: string }>(`select balance_cents as b from accounts where user_id = $1 and kind = 'real'`, [userId]);
  return Number(rows[0]?.b);
}

async function kinds(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ kind: string }>('select kind from ledger where user_id = $1 order by id', [userId]);
  return rows.map((r) => r.kind);
}

beforeAll(() => {
  pool = createPool(loadConfig());
});

beforeEach(() => {
  gw = new FakeGateway();
  svc = createPaymentService({ pool, gateway: gw, webhookSecrets: [KEY], postbackUrl: null });
});

afterAll(async () => {
  const users = `select id from users where email like '%@${DOMAIN}'`;
  await pool.query(`delete from ledger where user_id in (${users})`);
  await pool.query(`delete from admin_audit where admin_id in (${users})`);
  await pool.query(`delete from deposits where user_id in (${users})`);
  await pool.query(`delete from withdrawals where user_id in (${users})`);
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`]);
  await pool.end();
});

describe('deposits', () => {
  it('asks for a valid CPF once, creates the Pix charge and credits the real account once when paid', async () => {
    const user = await newUser();
    await expect(svc.createDeposit(user, { amountCents: 5000, cpf: '111.111.111-11' })).rejects.toMatchObject({ statusCode: 400 });

    const cpf = freshCpf();
    const dep = await svc.createDeposit(user, { amountCents: 5000, cpf });
    expect(dep).toMatchObject({ status: 'pending', amountCents: 5000, pixCode: '00020126PIXCODE' });
    expect(gw.charges[0]).toMatchObject({ externalId: dep.id, amountCents: 5000, payer: { cpf } });
    expect((await svc.info(user)).cpf).toBe(`***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`);

    // The second deposit reuses the CPF on file; another account cannot take it.
    await svc.createDeposit(user, { amountCents: 2000 });
    expect(gw.charges[1]?.payer.cpf).toBe(cpf);
    await expect(svc.createDeposit(await newUser(), { amountCents: 2000, cpf })).rejects.toMatchObject({ statusCode: 409 });

    // Paid: polling pulls the status; a duplicate notification changes nothing.
    gw.chargeStatus.set(`inv-${dep.id}`, 'paid');
    expect((await svc.getDeposit(user, dep.id)).status).toBe('paid');
    await svc.applyChargeState({ providerId: `inv-${dep.id}`, externalId: dep.id, status: 'paid', amountCents: 5000 });
    expect(await real(user)).toBe(5000);
    expect(await kinds(user)).toEqual(['deposit']);
  });

  it('takes a reversed deposit back from the balance', async () => {
    const user = await newUser();
    const dep = await svc.createDeposit(user, { amountCents: 3000, cpf: freshCpf() });
    await svc.applyChargeState({ providerId: `inv-${dep.id}`, externalId: null, status: 'paid', amountCents: 3000 });
    await svc.applyChargeState({ providerId: `inv-${dep.id}`, externalId: null, status: 'chargedback', amountCents: 3000 });
    expect(await real(user)).toBe(0);
    expect(await kinds(user)).toEqual(['deposit', 'deposit_reversal']);
  });

  it('refuses amounts outside the limits and is off without a gateway', async () => {
    const user = await newUser();
    await expect(svc.createDeposit(user, { amountCents: 500, cpf: freshCpf() })).rejects.toMatchObject({ statusCode: 400 });
    const off = createPaymentService({ pool, gateway: null, webhookSecrets: [], postbackUrl: null });
    await expect(off.createDeposit(user, { amountCents: 5000, cpf: freshCpf() })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('withdrawals', () => {
  it('debits on request, refunds on rejection', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    await expect(svc.requestWithdrawal(user, { amountCents: 20_000, pixKeyType: 'CPF', pixKey: VALID_CPF })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(svc.requestWithdrawal(user, { amountCents: 5000, pixKeyType: 'CPF', pixKey: '123' })).rejects.toMatchObject({
      statusCode: 400,
    });
    const w = await svc.requestWithdrawal(user, { amountCents: 6000, pixKeyType: 'EMAIL', pixKey: ' Ana@Example.com ' });
    expect(w).toMatchObject({ status: 'requested', pixKey: 'ana@example.com' });
    expect(await real(user)).toBe(4000);

    expect(await svc.reject(admin, w.id, 'Chave de terceiro')).toMatchObject({ status: 'rejected', note: 'Chave de terceiro' });
    expect(await real(user)).toBe(10_000);
    await expect(svc.reject(admin, w.id, 'de novo')).rejects.toMatchObject({ statusCode: 409 });
    expect(await kinds(user)).toEqual(['withdrawal', 'withdrawal_return']);
  });

  it('approval sends the payout; a failed send can be retried; completion is final', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const w = await svc.requestWithdrawal(user, { amountCents: 5000, pixKeyType: 'PHONE', pixKey: '(11) 99999-8888' });
    expect(w.pixKey).toBe('+5511999998888');

    gw.failNextPayout = true;
    await expect(svc.approve(admin, w.id)).rejects.toMatchObject({ statusCode: 502 });
    expect((await svc.adminList({ status: 'open', limit: 50 })).items.find((x) => x.id === w.id)).toMatchObject({
      status: 'approved',
      lastError: expect.stringContaining('500'),
    });

    expect(await svc.approve(admin, w.id)).toMatchObject({ status: 'processing' });
    expect(gw.payouts).toEqual([expect.objectContaining({ externalId: w.id, amountCents: 5000, pixKeyType: 'PHONE' })]);
    await expect(svc.approve(admin, w.id)).rejects.toMatchObject({ statusCode: 409 });

    expect(await svc.refreshWithdrawal(w.id)).toMatchObject({ status: 'completed' });
    expect(await real(user)).toBe(5000);
  });

  it('a payout the bank fails or sends back returns the money', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const a = await svc.requestWithdrawal(user, { amountCents: 3000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await svc.approve(admin, a.id);
    await svc.applyPayoutState({ providerId: `po-${a.id}`, externalId: a.id, status: 'failed', amountCents: 3000, refundedAmountCents: null });
    expect(await real(user)).toBe(10_000);

    const b = await svc.requestWithdrawal(user, { amountCents: 4000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await svc.approve(admin, b.id);
    await svc.applyPayoutState({ providerId: `po-${b.id}`, externalId: null, status: 'completed', amountCents: 4000, refundedAmountCents: null });
    await svc.applyPayoutState({ providerId: `po-${b.id}`, externalId: null, status: 'refunded', amountCents: 4000, refundedAmountCents: 3900 });
    expect(await real(user)).toBe(10_000 - 4000 + 3900);
    // Repeated notifications do nothing more.
    await svc.applyPayoutState({ providerId: `po-${b.id}`, externalId: null, status: 'refunded', amountCents: 4000, refundedAmountCents: 3900 });
    expect(await real(user)).toBe(9900);
  });
});

describe('webhook route', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await testApp({ deps: { payments: createPaymentService({ pool, gateway: new FakeGateway(), webhookSecrets: [KEY], postbackUrl: null }) } });
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: string, sig?: string) =>
    app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-webhook-signature': sig } : {}) },
      payload: body,
    });
  const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex');

  it('credits a signed invoice.paid postback without a session or CSRF token, and rejects a bad signature', async () => {
    const user = await newUser();
    const s = createPaymentService({ pool, gateway: gw, webhookSecrets: [KEY], postbackUrl: null });
    const dep = await s.createDeposit(user, { amountCents: 2500, cpf: freshCpf() });
    const body = JSON.stringify({ id: `inv-${dep.id}`, status: 'paid', amount: 2500, method: 'pix', event: 'invoice.paid', external_id: dep.id });

    expect((await post(body, 'deadbeef')).statusCode).toBe(401);
    expect((await post(body)).statusCode).toBe(401);
    expect(await real(user)).toBe(0);

    const ok = await post(body, sign(body));
    expect(ok.statusCode).toBe(200);
    expect(await real(user)).toBe(2500);
    expect((await post(body, sign(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(2500);
  });

  it('applies a signed global withdrawal envelope', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const s = createPaymentService({ pool, gateway: gw, webhookSecrets: [KEY], postbackUrl: null });
    const w = await s.requestWithdrawal(user, { amountCents: 2000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await s.approve(admin, w.id);
    const body = JSON.stringify({
      event: 'withdrawal.cancelled',
      timestamp: '2026-11-07T12:00:00Z',
      data: { id: `po-${w.id}`, status: 'canceled', amount: 2000, net_amount: 1990, type: 'withdrawal', external_id: w.id },
    });
    expect((await post(body, sign(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(10_000);
  });
});
