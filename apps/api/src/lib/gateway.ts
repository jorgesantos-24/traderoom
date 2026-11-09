/**
 * What the payment service needs from a Pix gateway (Novus or EaglePay).
 * Amounts are always integer centavos of BRL here, whatever the gateway's own wire format.
 *
 * Statuses are lowercase. Each gateway maps its own words onto these so the service can act on them:
 * - charges: pending | paid | expired | canceled | failed | refunded | chargeback (anything else is just stored)
 * - payouts: pending | processing | completed | failed | canceled | refunded (anything else is just stored)
 */
import type { PixKeyType } from '@traderoom/shared';

export type GatewayName = 'novus' | 'eagle';

export interface ChargeRequest {
  /** Our deposit id: sent as the external reference and as the Idempotency-Key. */
  externalId: string;
  amountCents: number;
  payer: { name: string; cpf: string; email: string };
  postbackUrl: string | null;
}

export interface ChargeCreated {
  providerId: string;
  pixCode: string | null;
  expiresAt: string | null;
  status: string;
}

export interface ChargeState {
  providerId: string;
  externalId: string | null;
  status: string;
  /** Paid amount when the gateway reports one. */
  amountCents: number | null;
}

export interface PayoutRequest {
  /** Our withdrawal id: sent as the external reference and as the Idempotency-Key. */
  externalId: string;
  amountCents: number;
  pixKey: string;
  pixKeyType: PixKeyType;
  description: string;
  postbackUrl: string | null;
}

export interface PayoutState {
  providerId: string;
  externalId: string | null;
  status: string;
  amountCents: number | null;
  refundedAmountCents: number | null;
}

/** A verified notification from the gateway. */
export type WebhookEvent =
  /** The payload itself carries the new state. */
  | { kind: 'charge'; state: ChargeState }
  | { kind: 'payout'; state: PayoutState }
  /** The payload only names the charge: its status is read from the API before anything is credited. */
  | { kind: 'charge-ref'; providerId: string }
  /** Signed, but nothing we act on. */
  | { kind: 'ignored' };

export type Headers = Record<string, string | string[] | undefined>;

export interface PaymentGateway {
  readonly name: GatewayName;
  /** Shown in admin error messages. */
  readonly label: string;
  createPixCharge(req: ChargeRequest): Promise<ChargeCreated>;
  getCharge(providerId: string): Promise<ChargeState>;
  createPayout(req: PayoutRequest): Promise<PayoutState>;
  getPayout(providerId: string): Promise<PayoutState>;
  /** Checks the signature and reads the payload. Null = bad or missing signature. */
  parseWebhook(rawBody: Buffer, headers: Headers): WebhookEvent | null;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export const header = (h: Headers, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Where each gateway posts status changes. Exempt from CSRF and sessions; authenticated by signature. */
export const webhookPath = (name: GatewayName): string => `/api/webhooks/${name}`;
export const WEBHOOK_PATHS: readonly string[] = [webhookPath('novus'), webhookPath('eagle')];
