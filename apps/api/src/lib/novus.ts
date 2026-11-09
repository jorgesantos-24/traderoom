/**
 * Client for the Novus Pagamentos API (https://app.novuspagamentos.com/docs).
 * Auth: `Authorization: Bearer <private key>`. Amounts are integer centavos.
 * Per-transaction postbacks are signed with HMAC-SHA256(raw body, private key) in X-Webhook-Signature (hex).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayError,
  header,
  type ChargeState,
  type Headers,
  type PaymentGateway,
  type PayoutState,
  type WebhookEvent,
} from './gateway.js';

export { GatewayError } from './gateway.js';
export type { ChargeCreated, ChargeRequest, ChargeState, PaymentGateway, PayoutRequest, PayoutState } from './gateway.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
/** Responses come as `{ data: {...} }`; webhooks may come wrapped in `{ event, timestamp, data }` or bare. */
const unwrap = (body: unknown): Json => {
  const b = obj(body);
  return 'data' in b && typeof b.data === 'object' && b.data !== null ? obj(b.data) : b;
};

export function parseChargeState(body: unknown): ChargeState {
  const d = unwrap(body);
  const providerId = str(d.invoice_id) ?? str(d.id);
  if (!providerId) throw new GatewayError('Resposta da Novus sem id da cobrança.', 502);
  return {
    providerId,
    externalId: str(d.external_id),
    status: (str(d.status) ?? 'unknown').toLowerCase(),
    amountCents: int(d.amount) ?? int(d.total) ?? int(d.total_cents),
  };
}

export function parsePayoutState(body: unknown): PayoutState {
  const d = unwrap(body);
  const providerId = str(d.id);
  if (!providerId) throw new GatewayError('Resposta da Novus sem id do saque.', 502);
  return {
    providerId,
    externalId: str(d.external_id),
    status: (str(d.status) ?? 'unknown').toLowerCase(),
    amountCents: int(d.amount),
    refundedAmountCents: int(d.refunded_amount),
  };
}

/** True for a payload that describes a payout (withdrawal) rather than a charge. */
export function isPayoutPayload(body: unknown): boolean {
  const b = obj(body);
  const event = str(b.event) ?? '';
  const d = unwrap(body);
  return event.startsWith('withdrawal.') || str(d.type) === 'withdrawal' || 'net_amount' in d || 'pix_key' in d;
}

export function verifySignature(rawBody: Buffer, signatureHex: string | undefined, secret: string): boolean {
  if (!signatureHex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHex.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads a Novus notification. Postbacks are signed with the private key; a global webhook with its whsec_ secret.
 * Novus payloads carry the full state, so it is applied as is.
 */
export function novusWebhookParser(secrets: string[]): (rawBody: Buffer, headers: Headers) => WebhookEvent | null {
  return (rawBody, headers) => {
    const sig = header(headers, 'x-webhook-signature');
    if (!secrets.some((s) => verifySignature(rawBody, sig, s))) return null;
    const body: unknown = JSON.parse(rawBody.toString('utf8'));
    return isPayoutPayload(body) ? { kind: 'payout', state: parsePayoutState(body) } : { kind: 'charge', state: parseChargeState(body) };
  };
}

export interface NovusOptions {
  apiKey: string;
  /** Secret (whsec_...) of a global webhook, besides the private key that signs postbacks. */
  webhookSecret?: string;
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createNovusGateway(opts: NovusOptions): PaymentGateway {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.apiKey}`,
      accept: 'application/json',
    };
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
      throw new GatewayError(`Sem resposta da Novus (${err instanceof Error ? err.name : 'erro de rede'}).`, 504);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error page.
    }
    if (!res.ok) {
      const msg = str(obj(json).message) ?? str(obj(obj(json).error).message) ?? text.slice(0, 200);
      throw new GatewayError(`Novus respondeu ${res.status}: ${msg || 'sem detalhes'}`, res.status);
    }
    return json;
  }

  return {
    name: 'novus',
    label: 'Novus',
    parseWebhook: novusWebhookParser([opts.apiKey, opts.webhookSecret].filter((x): x is string => Boolean(x))),

    async createPixCharge(req) {
      const body = await call(
        'POST',
        '/invoices',
        {
          method: 'pix',
          currency: 'BRL',
          country: 'BR',
          total_price_cents: req.amountCents,
          payer: { name: req.payer.name, cpf_cnpj: req.payer.cpf, email: req.payer.email },
          items: [{ name: 'Depósito em conta', unit_price: req.amountCents, quantity: 1 }],
          external_id: req.externalId,
          ...(req.postbackUrl ? { postback_url: req.postbackUrl } : {}),
        },
        req.externalId,
      );
      const d = unwrap(body);
      const pix = obj(d.pix);
      const state = parseChargeState(body);
      return {
        providerId: state.providerId,
        pixCode: str(pix.qrcode) ?? str(d.qr_code_pix) ?? str(d.qr_code),
        expiresAt: str(pix.expirationDate) ?? str(d.expires_at),
        status: state.status,
      };
    },

    async getCharge(providerId) {
      return parseChargeState(await call('GET', `/invoices/${encodeURIComponent(providerId)}`));
    },

    async createPayout(req) {
      const body = await call(
        'POST',
        '/payout',
        {
          amount: req.amountCents,
          currency: 'BRL',
          type: 'pix',
          pix_key: req.pixKey,
          pix_key_type: req.pixKeyType,
          external_id: req.externalId,
          description: req.description,
          ...(req.postbackUrl ? { postback_url: req.postbackUrl } : {}),
        },
        req.externalId,
      );
      return parsePayoutState(body);
    },

    async getPayout(providerId) {
      return parsePayoutState(await call('GET', `/payout/${encodeURIComponent(providerId)}`));
    },
  };
}
