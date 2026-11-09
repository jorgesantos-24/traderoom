// Requires `npm run dev:deps` and `npm run db:migrate` first.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/lib/db.js';
import { fixedFx, FxUnavailableError, type FxService } from '../src/lib/fx.js';
import { createEagleGateway } from '../src/lib/eagle.js';
import {
  GatewayError,
  webhookPath,
  type ChargeRequest,
  type GatewayName,
  type PaymentGateway,
  type PayoutRequest,
  type PayoutState,
} from '../src/lib/gateway.js';
import { novusWebhookParser } from '../src/lib/novus.js';
import { createPaymentService, type PaymentService } from '../src/services/payments.js';
import { testApp } from './helpers.js';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DOMAIN = 'payments-int.traderoom.test';
const KEY = 'test-private-key';
const VALID_CPF = '52998224725';
/** Deposits: R$ 5 buys US$ 1. Withdrawals: US$ 1 pays R$ 4,90. */
const fx = fixedFx(5, 4.9);
const noFx: FxService = { quote: () => Promise.reject(new FxUnavailableError('down')) };

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

/** In-memory stand-in for a gateway; its webhooks are signed the Novus way. */
class FakeGateway implements PaymentGateway {
  readonly label: string;
  constructor(readonly name: GatewayName = 'novus') {
    this.label = name;
  }
  parseWebhook = novusWebhookParser([KEY]);
  charges: ChargeRequest[] = [];
  payouts: PayoutRequest[] = [];
  chargeStatus = new Map<string, string>();
  payoutStatus = 'completed';
  chargeCalls = 0;
  failNextPayout = false;
  async createPixCharge(req: ChargeRequest) {
    this.charges.push(req);
    const providerId = `inv-${req.externalId}`;
    this.chargeStatus.set(providerId, 'pending');
    return { providerId, pixCode: '00020126PIXCODE', expiresAt: null, status: 'pending' };
  }
  async getCharge(providerId: string) {
    this.chargeCalls++;
    return { providerId, externalId: null, status: this.chargeStatus.get(providerId) ?? 'pending', amountCents: null };
  }
  async createPayout(req: PayoutRequest): Promise<PayoutState> {
    if (this.failNextPayout) {
      this.failNextPayout = false;
      throw new GatewayError('Novus respondeu 500: indisponível', 500);
    }
    this.payouts.push(req);
    return {
      providerId: `po-${req.externalId}`,
      externalId: req.externalId,
      status: 'pending',
      amountCents: req.amountCents,
      refundedAmountCents: null,
    };
  }
  async getPayout(providerId: string): Promise<PayoutState> {
    return { providerId, externalId: null, status: this.payoutStatus, amountCents: null, refundedAmountCents: null };
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
  const { rows } = await pool.query<{ b: string }>(`select balance_cents as b from accounts where user_id = $1 and kind = 'real'`, [
    userId,
  ]);
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
  svc = createPaymentService({ pool, gateway: gw, postbackUrl: null, fx });
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
  it('asks for a valid CPF once, creates the Pix charge in reais and credits dollars once when paid', async () => {
    const user = await newUser();
    await expect(svc.createDeposit(user, { amountCents: 5000, cpf: '111.111.111-11' })).rejects.toMatchObject({ statusCode: 400 });

    const cpf = freshCpf();
    const dep = await svc.createDeposit(user, { amountCents: 5000, cpf });
    expect(dep).toMatchObject({ status: 'pending', amountCents: 5000, usdCents: 1000, fxRate: 5, pixCode: '00020126PIXCODE' });
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
    expect(await real(user)).toBe(1000);
    expect(await kinds(user)).toEqual(['deposit']);
    expect((await svc.getDeposit(user, dep.id)).usdCents).toBe(1000);
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
    const off = createPaymentService({ pool, gateway: null, postbackUrl: null, fx });
    await expect(off.createDeposit(user, { amountCents: 5000, cpf: freshCpf() })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('shows the quote and pauses deposits and withdrawals without one', async () => {
    const user = await newUser(10_000);
    expect(await svc.info(user)).toMatchObject({ depositRate: 5, withdrawRate: 4.9 });
    const blind = createPaymentService({ pool, gateway: gw, postbackUrl: null, fx: noFx });
    expect(await blind.info(user)).toMatchObject({ depositRate: null, withdrawRate: null });
    await expect(blind.createDeposit(user, { amountCents: 5000, cpf: freshCpf() })).rejects.toMatchObject({ statusCode: 503 });
    await expect(blind.requestWithdrawal(user, { amountCents: 1000, pixKeyType: 'CPF', pixKey: VALID_CPF })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await real(user)).toBe(10_000);
    expect(gw.charges).toEqual([]);
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
    expect(w).toMatchObject({ status: 'requested', pixKey: 'ana@example.com', amountCents: 6000, pixAmountCents: 29_400, fxRate: 4.9 });
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
    expect(gw.payouts).toEqual([expect.objectContaining({ externalId: w.id, amountCents: 24_500, pixKeyType: 'PHONE' })]);
    await expect(svc.approve(admin, w.id)).rejects.toMatchObject({ statusCode: 409 });

    expect(await svc.refreshWithdrawal(w.id)).toMatchObject({ status: 'completed' });
    expect(await real(user)).toBe(5000);
  });

  it('a payout the bank fails or sends back returns the money', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const a = await svc.requestWithdrawal(user, { amountCents: 3000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await svc.approve(admin, a.id);
    await svc.applyPayoutState({
      providerId: `po-${a.id}`,
      externalId: a.id,
      status: 'failed',
      amountCents: 3000,
      refundedAmountCents: null,
    });
    expect(await real(user)).toBe(10_000);

    const b = await svc.requestWithdrawal(user, { amountCents: 4000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await svc.approve(admin, b.id);
    await svc.applyPayoutState({
      providerId: `po-${b.id}`,
      externalId: null,
      status: 'completed',
      amountCents: 4000,
      refundedAmountCents: null,
    });
    // The bank returns reais (R$ 191,10 = US$ 39,00 at the withdrawal's rate).
    await svc.applyPayoutState({
      providerId: `po-${b.id}`,
      externalId: null,
      status: 'refunded',
      amountCents: 19_600,
      refundedAmountCents: 19_110,
    });
    expect(await real(user)).toBe(10_000 - 4000 + 3900);
    // Repeated notifications do nothing more.
    await svc.applyPayoutState({
      providerId: `po-${b.id}`,
      externalId: null,
      status: 'refunded',
      amountCents: 19_600,
      refundedAmountCents: 19_110,
    });
    expect(await real(user)).toBe(9900);
  });
});

describe('webhook route', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await testApp({
      deps: { payments: createPaymentService({ pool, gateway: new FakeGateway(), postbackUrl: null, fx }) },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: string, sig?: string) =>
    app.inject({
      method: 'POST',
      url: webhookPath('novus'),
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-webhook-signature': sig } : {}) },
      payload: body,
    });
  const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex');

  it('credits a signed invoice.paid postback without a session or CSRF token, and rejects a bad signature', async () => {
    const user = await newUser();
    const s = createPaymentService({ pool, gateway: gw, postbackUrl: null, fx });
    const dep = await s.createDeposit(user, { amountCents: 2500, cpf: freshCpf() });
    const body = JSON.stringify({
      id: `inv-${dep.id}`,
      status: 'paid',
      amount: 2500,
      method: 'pix',
      event: 'invoice.paid',
      external_id: dep.id,
    });

    expect((await post(body, 'deadbeef')).statusCode).toBe(401);
    expect((await post(body)).statusCode).toBe(401);
    expect(await real(user)).toBe(0);

    const ok = await post(body, sign(body));
    expect(ok.statusCode).toBe(200);
    expect(await real(user)).toBe(500);
    expect((await post(body, sign(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(500);
  });

  it('applies a signed global withdrawal envelope', async () => {
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const s = createPaymentService({ pool, gateway: gw, postbackUrl: null, fx });
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

describe('several gateways', () => {
  it('asks only the gateway that holds a transaction, and keeps hearing the previous one', async () => {
    const novus = new FakeGateway('novus');
    const eagle = new FakeGateway('eagle');
    const before = createPaymentService({ pool, gateway: novus, postbackUrl: null, fx });
    const user = await newUser();
    const old = await before.createDeposit(user, { amountCents: 2000, cpf: freshCpf() });

    // Switched to EaglePay: new deposits go there, the Novus one is still checked at Novus.
    const after = createPaymentService({ pool, gateway: eagle, previousGateways: [novus], postbackUrl: null, fx });
    const fresh = await after.createDeposit(user, { amountCents: 3000 });
    expect(eagle.charges.map((c) => c.externalId)).toEqual([fresh.id]);
    novus.chargeStatus.set(`inv-${old.id}`, 'paid');
    const eagleCalls = eagle.chargeCalls;
    expect((await after.getDeposit(user, old.id)).status).toBe('paid');
    expect(eagle.chargeCalls).toBe(eagleCalls);
    expect(await real(user)).toBe(400);

    // A state reported by one gateway never touches the other's row with the same id.
    await after.applyChargeState({ providerId: `inv-${fresh.id}`, externalId: null, status: 'paid', amountCents: 3000 }, 'novus');
    expect((await after.getDeposit(user, fresh.id)).status).toBe('pending');
  });

  it('the sync closes overdue charges, credits a late payment and finishes payouts', async () => {
    const g = new FakeGateway('eagle');
    const s = createPaymentService({ pool, gateway: g, postbackUrl: null, fx });
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const dep = await s.createDeposit(user, { amountCents: 2500, cpf: freshCpf() });
    await pool.query(
      `update deposits set created_at = now() - interval '2 days', expires_at = now() - interval '1 day', updated_at = '2000-01-01' where id = $1`,
      [dep.id],
    );
    const w = await s.requestWithdrawal(user, { amountCents: 2000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    g.payoutStatus = 'awaiting';
    await s.approve(admin, w.id);
    await pool.query(`update withdrawals set updated_at = '2000-01-01' where id = $1`, [w.id]);

    await s.syncOpen();
    expect((await s.getDeposit(user, dep.id)).status).toBe('expired');
    expect((await s.adminList({ status: 'all', limit: 50 })).items.find((x) => x.id === w.id)).toMatchObject({
      status: 'processing',
      providerStatus: 'awaiting',
    });

    g.payoutStatus = 'failed';
    await pool.query(`update withdrawals set updated_at = '2000-01-01' where id = $1`, [w.id]);
    await s.syncOpen();
    expect((await s.adminList({ status: 'all', limit: 50 })).items.find((x) => x.id === w.id)?.status).toBe('failed');
    expect(await real(user)).toBe(10_000);

    // Paid after we closed it: the money arrived, so it is credited.
    await s.applyChargeState({ providerId: `inv-${dep.id}`, externalId: null, status: 'paid', amountCents: 2500 });
    expect((await s.getDeposit(user, dep.id)).status).toBe('paid');
    expect(await real(user)).toBe(10_500);
  });
});

describe('EaglePay end to end (fake API)', () => {
  const SECRET = 'eagle-secret';
  type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
  let calls: Call[];
  let txStatus: string;
  let wdStatus: string;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    calls.push({ method: init?.method ?? 'GET', url, headers, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/v1/public/payment/transaction')) {
      return json(200, {
        id: 'tx-1',
        amount: 5000,
        status: 'processing',
        pix: { qrcode: 'data:image/png;base64,AAA', brcode: '000201EAGLE' },
      });
    }
    if (url.endsWith('/api/v1/public/payment/transaction/tx-1')) return json(200, { id: 'tx-1', amount: 5000, status: txStatus });
    if (url.endsWith('/api/v1/withdraw/request')) return json(200, { id: 512, amount: 245, status: 'Awaiting' });
    if (url.endsWith('/api/v1/withdraw/512')) return json(200, { id: 512, amount: 245, status: wdStatus });
    return json(404, { message: 'not found' });
  };

  let app: FastifyInstance;
  let s: PaymentService;
  beforeAll(async () => {
    const eagle = createEagleGateway({
      clientId: 'cid',
      publicKey: 'pub',
      secretKey: SECRET,
      baseUrl: 'https://eagle.test',
      fetch: fakeFetch,
    });
    s = createPaymentService({ pool, gateway: eagle, postbackUrl: 'https://x.test/api/webhooks/eagle', fx });
    app = await testApp({ deps: { payments: s } });
  });
  beforeEach(() => {
    calls = [];
    txStatus = 'processing';
    wdStatus = 'Awaiting';
  });
  afterAll(async () => {
    await app.close();
  });

  const signed = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'content-type': 'application/json',
    'x-eagle-timestamp': String(ts),
    'x-eagle-signature': 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex'),
  });

  it('creates the charge, and a signed webhook credits only after the API confirms', async () => {
    // A previous run may have left a charge with the same fake id.
    await pool.query(`update deposits set provider_id = null where provider = 'eagle' and provider_id = 'tx-1'`);
    const user = await newUser();
    const cpf = freshCpf();
    const dep = await s.createDeposit(user, { amountCents: 5000, cpf });
    expect(dep.pixCode).toBe('000201EAGLE');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://eagle.test/api/v1/public/payment/transaction',
      headers: { 'x-client-id': 'cid', 'x-public-key': 'pub', 'idempotency-key': dep.id },
      body: {
        amount: 5000,
        paymentMethod: 'pix',
        customer: { document: { number: cpf, type: 'cpf' }, externalRef: dep.id },
        postbackUrl: 'https://x.test/api/webhooks/eagle',
        metadata: dep.id,
      },
    });
    expect(calls[0]?.headers).not.toHaveProperty('x-secret-key');

    const body = JSON.stringify({ transactionId: 'tx-1', externalId: dep.id, enStatusTransaction: 'paid', value: 50 });
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: webhookPath('eagle'), headers, payload: body });

    expect((await post({ 'content-type': 'application/json' })).statusCode).toBe(401);
    expect((await post(signed(body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);

    // The API still says processing: nothing is credited, whatever the payload claims.
    expect((await post(signed(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(0);

    txStatus = 'completed';
    expect((await post(signed(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(1000);
    expect((await post(signed(body))).statusCode).toBe(200);
    expect(await real(user)).toBe(1000);
  });

  it('sends the payout in reais with the secret key, then follows it to Successful', async () => {
    await pool.query(`update withdrawals set provider_id = null where provider = 'eagle' and provider_id = '512'`);
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    const w = await s.requestWithdrawal(user, { amountCents: 5000, pixKeyType: 'EMAIL', pixKey: 'ana@example.com' });
    expect(await s.approve(admin, w.id)).toMatchObject({ status: 'processing', providerStatus: 'awaiting' });
    expect(calls[0]).toMatchObject({
      url: 'https://eagle.test/api/v1/withdraw/request',
      headers: { 'x-client-id': 'cid', 'x-secret-key': SECRET, 'idempotency-key': w.id },
      body: { amount: 245, currency: 'BRL', pixKey: 'ana@example.com', pixKeyType: 'email' },
    });
    expect(calls[0]?.headers).not.toHaveProperty('x-public-key');

    wdStatus = 'Successful';
    expect(await s.refreshWithdrawal(w.id)).toMatchObject({ status: 'completed' });
    expect(await real(user)).toBe(5000);
  });
});

describe('withdrawal fee', () => {
  it('keeps 2% for the broker and sends the rest by Pix; a refused or failed payout returns everything', async () => {
    const s = createPaymentService({ pool, gateway: gw, postbackUrl: null, fx, withdrawFeePct: 2 });
    const user = await newUser(20_000);
    const admin = await newUser(0, 'admin');
    expect((await s.info(user)).withdrawFeePct).toBe(2);

    // US$ 100 asked: US$ 100 leaves the balance, US$ 2 stays with the broker, US$ 98 = R$ 480,20 goes by Pix.
    const w = await s.requestWithdrawal(user, { amountCents: 10_000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    expect(w).toMatchObject({ amountCents: 10_000, feeCents: 200, pixAmountCents: 48_020 });
    expect(await real(user)).toBe(10_000);
    const { rows } = await pool.query<{ note: string }>(`select note from ledger where withdrawal_id = $1 and kind = 'withdrawal'`, [w.id]);
    expect(rows[0]?.note).toContain('taxa de saque US$');

    await s.approve(admin, w.id);
    expect(gw.payouts.at(-1)).toMatchObject({ externalId: w.id, amountCents: 48_020 });

    // Bank failed it: nothing reached the client, so the fee comes back too.
    await s.applyPayoutState({
      providerId: `po-${w.id}`,
      externalId: w.id,
      status: 'failed',
      amountCents: null,
      refundedAmountCents: null,
    });
    expect(await real(user)).toBe(20_000);

    const r = await s.requestWithdrawal(user, { amountCents: 5_000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    expect(r.feeCents).toBe(100);
    await s.reject(admin, r.id, 'Chave de terceiro');
    expect(await real(user)).toBe(20_000);

    // Half of the Pix sent back by the bank: half of what was asked returns.
    const h = await s.requestWithdrawal(user, { amountCents: 10_000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    await s.approve(admin, h.id);
    await s.applyPayoutState({
      providerId: `po-${h.id}`,
      externalId: h.id,
      status: 'completed',
      amountCents: null,
      refundedAmountCents: null,
    });
    await s.applyPayoutState({
      providerId: `po-${h.id}`,
      externalId: h.id,
      status: 'refunded',
      amountCents: null,
      refundedAmountCents: 24_010,
    });
    expect(await real(user)).toBe(15_000);
  });
});

describe('instant withdrawals', () => {
  const make = (instant: number | null) =>
    createPaymentService({ pool, gateway: gw, postbackUrl: null, fx, withdrawFeePct: 2, instantWithdrawFeePct: instant });

  it('charges 7% and goes to the gateway at once, with no admin', async () => {
    const s = make(7);
    const user = await newUser(20_000);
    expect(await s.info(user)).toMatchObject({ withdrawFeePct: 2, instantWithdrawFeePct: 7 });

    // US$ 100 asked: US$ 7 kept, US$ 93 = R$ 455,70 sent right away.
    const w = await s.requestWithdrawal(user, { amountCents: 10_000, pixKeyType: 'CPF', pixKey: VALID_CPF, speed: 'instant' });
    expect(w).toMatchObject({ speed: 'instant', feeCents: 700, pixAmountCents: 45_570, status: 'processing' });
    expect(gw.payouts.at(-1)).toMatchObject({ externalId: w.id, amountCents: 45_570 });
    expect(await real(user)).toBe(10_000);

    // Standard stays waiting for review at 2%.
    const n = await s.requestWithdrawal(user, { amountCents: 5_000, pixKeyType: 'CPF', pixKey: VALID_CPF });
    expect(n).toMatchObject({ speed: 'standard', feeCents: 100, status: 'requested' });
    expect(gw.payouts.at(-1)?.externalId).toBe(w.id);
  });

  it('a failed instant send waits for the admin, who can refuse it only once no send is in flight', async () => {
    const s = make(7);
    const user = await newUser(10_000);
    const admin = await newUser(0, 'admin');
    gw.failNextPayout = true;
    const w = await s.requestWithdrawal(user, { amountCents: 4_000, pixKeyType: 'CPF', pixKey: VALID_CPF, speed: 'instant' });
    expect(w.status).toBe('approved');
    expect(await real(user)).toBe(6_000);
    const listed = (await s.adminList({ status: 'open', limit: 50 })).items.find((x) => x.id === w.id);
    expect(listed).toMatchObject({ speed: 'instant', lastError: expect.stringContaining('500') });

    // While a send may still be on its way, refusing (and refunding) is blocked.
    await pool.query('update withdrawals set send_started_at = now(), last_error = null where id = $1', [w.id]);
    await expect(s.reject(admin, w.id, 'Chave errada')).rejects.toMatchObject({ statusCode: 409 });
    await expect(s.approve(admin, w.id)).rejects.toMatchObject({ statusCode: 409 });

    await pool.query(`update withdrawals set send_started_at = now() - interval '10 minutes' where id = $1`, [w.id]);
    await s.reject(admin, w.id, 'Chave errada');
    expect(await real(user)).toBe(10_000);
  });

  it('is refused when instant withdrawals are off', async () => {
    const s = make(null);
    const user = await newUser(10_000);
    expect((await s.info(user)).instantWithdrawFeePct).toBeNull();
    await expect(
      s.requestWithdrawal(user, { amountCents: 2_000, pixKeyType: 'CPF', pixKey: VALID_CPF, speed: 'instant' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await real(user)).toBe(10_000);
  });
});
