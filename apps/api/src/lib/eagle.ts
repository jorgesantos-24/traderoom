/**
 * Client for the EaglePay API (docs: https://docs.eaglepagamentos.com.br, a single page).
 *
 * - Base https://api.eaglepagamentos.com.br. Every call sends `X-Client-Id`.
 * - Pix charges (`/api/v1/public/payment/transaction`) use `X-Public-Key`; amounts in centavos.
 * - Withdrawals (`/api/v1/withdraw/...`) and balance use `X-Secret-Key`; amounts in REAIS (decimal), minimum R$ 10,00.
 * - Withdrawals have no webhook: they are polled until Successful / Failure / Rejected.
 * - Charge webhooks: POST JSON with `transactionId` + `enStatusTransaction`, signed with
 *   `X-Eagle-Signature: sha256=<hex>` = HMAC-SHA256(secret key, `${X-Eagle-Timestamp}.${raw body}`).
 *   As the docs advise, the status is read back from the API before a deposit is credited.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PixKeyType } from '@traderoom/shared';
import { GatewayError, header, type ChargeState, type PaymentGateway, type PayoutState, type WebhookEvent } from './gateway.js';

export const EAGLE_API_URL = 'https://api.eaglepagamentos.com.br';
/** How old a signed webhook may be before it is treated as a replay. */
const MAX_WEBHOOK_AGE_S = 300;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
/** Decimal reais (150.00 or "150.00") to centavos. */
const reaisToCents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
/** Some responses may come wrapped in `{ data: {...} }`. */
const unwrap = (body: unknown): Json => {
  const b = obj(body);
  return 'data' in b && typeof b.data === 'object' && b.data !== null && !Array.isArray(b.data) ? obj(b.data) : b;
};

/** EaglePay charge status → the shared vocabulary (see gateway.ts). */
export function chargeStatus(raw: string | null): string {
  const s = (raw ?? 'unknown').toLowerCase();
  switch (s) {
    case 'processing':
    case 'waiting_payment':
    case 'pending':
      return 'pending';
    case 'completed':
    case 'paid':
    case 'approved':
      return 'paid';
    case 'rejected':
    case 'refused':
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'refunded':
      return 'refunded';
    case 'chargeback':
    case 'chargedback':
      return 'chargeback';
    default:
      return s;
  }
}

/** EaglePay withdrawal status (Awaiting, Processing, Successful, Failure, Rejected) → the shared vocabulary. */
export function payoutStatus(raw: string | null): string {
  const s = (raw ?? 'unknown').toLowerCase();
  switch (s) {
    case 'awaiting':
      // In EaglePay's own review: money not sent yet, still on its way.
      return 'awaiting';
    case 'processing':
      return 'processing';
    case 'successful':
    case 'completed':
      return 'completed';
    case 'failure':
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'refunded':
    case 'returned':
      return 'refunded';
    default:
      return s;
  }
}

export function parseEagleCharge(body: unknown): ChargeState {
  const d = unwrap(body);
  const providerId = str(d.id) ?? str(d.transactionId);
  if (!providerId) throw new GatewayError('Resposta da EaglePay sem id da transação.', 502);
  const meta = str(d.metadata);
  return {
    providerId,
    externalId: str(d.externalId) ?? str(obj(d.customer).externalRef) ?? meta,
    status: chargeStatus(str(d.status) ?? str(d.enStatusTransaction)),
    amountCents: int(d.amount),
  };
}

export function parseEaglePayout(body: unknown): PayoutState {
  const d = unwrap(body);
  const providerId = str(d.id);
  if (!providerId) throw new GatewayError('Resposta da EaglePay sem id do saque.', 502);
  return {
    providerId,
    externalId: null,
    status: payoutStatus(str(d.status)),
    amountCents: reaisToCents(d.amount),
    refundedAmountCents: null,
  };
}

const PIX_KEY_TYPES: Record<PixKeyType, string> = {
  CPF: 'cpf',
  CNPJ: 'cnpj',
  EMAIL: 'email',
  PHONE: 'phone',
  RANDOM: 'random',
};

export function verifyEagleSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secretKey: string,
  nowMs = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp.trim())) return false;
  const expected =
    'sha256=' +
    createHmac('sha256', secretKey)
      .update(Buffer.concat([Buffer.from(`${timestamp.trim()}.`, 'utf8'), rawBody]))
      .digest('hex');
  const a = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Math.abs(nowMs / 1000 - Number(timestamp)) <= MAX_WEBHOOK_AGE_S;
}

export interface EagleOptions {
  clientId: string;
  /** Pix API (charges). */
  publicKey: string;
  /** Withdrawals, balance and webhook signatures. */
  secretKey: string;
  baseUrl?: string;
  /** Validity of each Pix charge. */
  chargeExpiresInDays?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createEagleGateway(opts: EagleOptions): PaymentGateway {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = (opts.baseUrl ?? EAGLE_API_URL).replace(/\/+$/, '');
  const expiresInDays = opts.chargeExpiresInDays ?? 1;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    key: 'public' | 'secret',
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'x-client-id': opts.clientId, accept: 'application/json' };
    if (key === 'public') headers['x-public-key'] = opts.publicKey;
    else headers['x-secret-key'] = opts.secretKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new GatewayError(`Sem resposta da EaglePay (${err instanceof Error ? err.name : 'erro de rede'}).`, 504);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error page.
    }
    if (!res.ok) {
      const j = obj(json);
      const msg = str(j.message) ?? str(j.error) ?? str(obj(j.error).message) ?? str(j.title) ?? str(j.detail) ?? text.slice(0, 200);
      throw new GatewayError(`EaglePay respondeu ${res.status}: ${msg || 'sem detalhes'}`, res.status);
    }
    return json;
  }

  return {
    name: 'eagle',
    label: 'EaglePay',

    async createPixCharge(req) {
      const body = await call(
        'POST',
        '/api/v1/public/payment/transaction',
        'public',
        {
          amount: req.amountCents,
          paymentMethod: 'pix',
          currency: 'BRL',
          customer: {
            name: req.payer.name,
            email: req.payer.email,
            externalRef: req.externalId,
            document: { number: req.payer.cpf, type: 'cpf' },
          },
          items: [{ title: 'Depósito em conta', unitPrice: req.amountCents, quantity: 1, tangible: false, externalRef: req.externalId }],
          pix: { expiresInDays },
          ...(req.postbackUrl ? { postbackUrl: req.postbackUrl } : {}),
          metadata: req.externalId,
        },
        req.externalId,
      );
      const d = unwrap(body);
      const pix = obj(d.pix);
      const state = parseEagleCharge(body);
      const expiresAt =
        str(pix.expiresAt) ?? str(pix.expirationDate) ?? str(d.expiresAt) ?? new Date(now() + expiresInDays * 86_400_000).toISOString();
      return {
        providerId: state.providerId,
        pixCode: str(pix.brcode) ?? str(pix.qrcodeText) ?? str(pix.copyPaste),
        expiresAt,
        status: state.status,
      };
    },

    async getCharge(providerId) {
      return parseEagleCharge(await call('GET', `/api/v1/public/payment/transaction/${encodeURIComponent(providerId)}`, 'public'));
    },

    async createPayout(req) {
      const body = await call(
        'POST',
        '/api/v1/withdraw/request',
        'secret',
        {
          // Reais, not centavos (unlike charges).
          amount: Number((req.amountCents / 100).toFixed(2)),
          currency: 'BRL',
          pixKey: req.pixKey,
          pixKeyType: PIX_KEY_TYPES[req.pixKeyType],
          description: req.description,
        },
        req.externalId,
      );
      return { ...parseEaglePayout(body), externalId: req.externalId };
    },

    async getPayout(providerId) {
      return parseEaglePayout(await call('GET', `/api/v1/withdraw/${encodeURIComponent(providerId)}`, 'secret'));
    },

    parseWebhook(rawBody, headers): WebhookEvent | null {
      const ok = verifyEagleSignature(
        rawBody,
        header(headers, 'x-eagle-timestamp'),
        header(headers, 'x-eagle-signature'),
        opts.secretKey,
        now(),
      );
      if (!ok) return null;
      const d = unwrap(JSON.parse(rawBody.toString('utf8')) as unknown);
      const id = str(d.transactionId);
      return id ? { kind: 'charge-ref', providerId: id } : { kind: 'ignored' };
    },
  };
}
