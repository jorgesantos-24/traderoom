import {
  CSRF_HEADER,
  type AdminAssetPatch,
  type AdminAssetView,
  type AdminUserView,
  type AuditAction,
  type AuditEntryView,
  type IndicatorAccessResponse,
  type IndicatorAccessView,
  type PremiumIndicator,
  ErrorCode,
  IDEMPOTENCY_HEADER,
  type ApiErrorBody,
  type AssetsResponse,
  type CandleInterval,
  type CandlesResponse,
  type OrderStats,
  type StatsResult,
  type AccountKind,
  type AdminKycView,
  type KycFileKind,
  type KycStateView,
  type KycSubmitRequest,
  type AdminWithdrawalView,
  type CreateWithdrawalInput,
  type DepositView,
  type PaymentsInfo,
  type WithdrawalView,
  type CreateOrderRequest,
  type LedgerEntryView,
  type OrderStatus,
  type OrderView,
  type OtcOverrideInput,
  type OtcOverrideState,
  type OtcOverrideView,
  type Page,
  type PublicOverrideState,
  type PublicUser,
  type WalletView,
} from '@traderoom/shared';
import { parseServerTime, serverClock } from './clock';

export const NETWORK_ERROR = 'network_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fired on any 401 from an endpoint that needs a session, so the app can send the user to /login. */
export const SESSION_EXPIRED_EVENT = 'traderoom:session-expired';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const e = (v as { error?: unknown }).error;
  return typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string';
}

interface RequestOptions {
  body?: unknown;
  /** Sent as-is with its own content type (file uploads). */
  raw?: Blob;
  headers?: Record<string, string>;
  /** Auth endpoints answer 401 for bad credentials; that is not an expired session. */
  expectAnon?: boolean;
  signal?: AbortSignal;
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.raw) headers['content-type'] = opts.raw.type;
  else if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, NETWORK_ERROR, 'Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  const date = res.headers.get('date');
  if (date) serverClock.observe(Date.parse(date), sentAt, Date.now(), 1000);
  return res;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (method !== 'GET' && csrfToken === null && path !== '/api/auth/login') await refreshCsrf();
  let res = await send(method, path, opts);
  if (res.status === 403 && method !== 'GET') {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (isApiErrorBody(body) && body.error.code === ErrorCode.CsrfFailed) {
      // Cookie rotated by another tab or expired: fetch a fresh token and retry once.
      await refreshCsrf();
      res = await send(method, path, opts);
    }
  }
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !opts.expectAnon) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    if (isApiErrorBody(body)) throw new ApiError(res.status, body.error.code, body.error.message);
    throw new ApiError(res.status, ErrorCode.Internal, 'Erro inesperado no servidor. Tente novamente.');
  }
  return body as T;
}

export async function refreshCsrf(): Promise<void> {
  const r = await request<{ csrfToken: string }>('GET', '/api/auth/csrf', { expectAnon: true });
  csrfToken = r.csrfToken;
}

/** A fresh Idempotency-Key per order attempt (UUID: 36 chars of [0-9a-f-]). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /** Null when there is no valid session. */
  async me(): Promise<PublicUser | null> {
    try {
      return (await request<{ user: PublicUser }>('GET', '/api/me', { expectAnon: true })).user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  async login(email: string, password: string): Promise<PublicUser> {
    const r = await request<{ user: PublicUser; csrfToken: string }>('POST', '/api/auth/login', {
      body: { email, password },
      expectAnon: true,
    });
    csrfToken = r.csrfToken;
    return r.user;
  },
  register: (name: string, email: string, password: string) =>
    request<{ user: PublicUser }>('POST', '/api/auth/register', { body: { name, email, password }, expectAnon: true }),
  logout: () => request<void>('POST', '/api/auth/logout', { expectAnon: true }),
  forgot: (email: string) => request<void>('POST', '/api/auth/forgot', { body: { email }, expectAnon: true }),
  reset: (token: string, password: string) => request<void>('POST', '/api/auth/reset', { body: { token, password }, expectAnon: true }),

  assets: () => request<AssetsResponse>('GET', '/api/assets'),
  /** The latest `limit` candles, or with `before` (epoch ms) the `limit` opening before it. */
  candles: (symbol: string, interval: CandleInterval, limit: number, signal?: AbortSignal, before?: number) =>
    request<CandlesResponse>('GET', `/api/candles${qs({ symbol, interval, limit, before })}`, { signal }),
  /** Whether the platform is setting this asset's price now (price override). */
  marketOverride: (symbol: string, signal?: AbortSignal) =>
    request<PublicOverrideState>('GET', `/api/market/override${qs({ symbol })}`, { signal }),
  /** Real and demo balances, real first. */
  accounts: async () => (await request<{ accounts: WalletView[] }>('GET', '/api/accounts')).accounts,
  refillDemo: async () => (await request<{ wallet: WalletView }>('POST', '/api/accounts/demo/refill')).wallet,
  ledger: (account: AccountKind, cursor?: string, limit?: number) =>
    request<Page<LedgerEntryView>>('GET', `/api/ledger${qs({ account, cursor, limit })}`),
  orders: (q: { account: AccountKind; status?: OrderStatus; cursor?: string; limit?: number }) =>
    request<Page<OrderView>>('GET', `/api/orders${qs(q)}`),
  /** Análises de operações: totals and daily P/L of settled orders opened in [from, to). */
  orderStats: async (q: { account: AccountKind; result: StatsResult; from: string; to: string; tz: string }) =>
    (await request<{ stats: OrderStats }>('GET', `/api/orders/stats${qs(q)}`)).stats,
  orderHistory: (q: { account: AccountKind; result: StatsResult; from: string; to: string; cursor?: string; limit?: number }) =>
    request<Page<OrderView>>('GET', `/api/orders/history${qs(q)}`),

  payments: () => request<{ info: PaymentsInfo; deposits: DepositView[]; withdrawals: WithdrawalView[] }>('GET', '/api/payments'),
  createDeposit: async (amountCents: number, cpf?: string) =>
    (await request<{ deposit: DepositView }>('POST', '/api/deposits', { body: { amountCents, ...(cpf ? { cpf } : {}) } })).deposit,
  deposit: async (id: string) => (await request<{ deposit: DepositView }>('GET', `/api/deposits/${encodeURIComponent(id)}`)).deposit,
  kyc: () => request<KycStateView>('GET', '/api/kyc'),
  uploadKycFile: (kind: KycFileKind, image: Blob) => request<KycStateView>('PUT', `/api/kyc/files/${kind}`, { raw: image }),
  submitKyc: (input: KycSubmitRequest) => request<KycStateView>('POST', '/api/kyc/submit', { body: input }),
  createWithdrawal: async (input: CreateWithdrawalInput) =>
    (await request<{ withdrawal: WithdrawalView }>('POST', '/api/withdrawals', { body: input })).withdrawal,

  /** Premium chart indicators (SMC, patterns) this user may use. */
  indicatorAccess: async () => (await request<IndicatorAccessResponse>('GET', '/api/indicators/access')).indicators,

  admin: {
    indicatorAccess: async () => (await request<{ access: IndicatorAccessView[] }>('GET', '/api/admin/indicators')).access,
    grantIndicator: async (email: string, indicator: PremiumIndicator) =>
      (await request<{ access: IndicatorAccessView }>('POST', '/api/admin/indicators', { body: { email, indicator } })).access,
    revokeIndicator: (userId: string, indicator: PremiumIndicator) =>
      request<void>('DELETE', `/api/admin/indicators/${encodeURIComponent(userId)}/${indicator}`),
    kycList: (q: { status: 'pending' | 'all'; cursor?: string; limit?: number }) =>
      request<Page<AdminKycView>>('GET', `/api/admin/kyc${qs(q)}`),
    /** Same-origin image URL; the session cookie authorizes it. */
    kycFileUrl: (id: string, kind: KycFileKind) => `/api/admin/kyc/${encodeURIComponent(id)}/files/${kind}`,
    kycDecision: async (id: string, decision: 'approve' | 'reject', reason?: string) =>
      (
        await request<{ submission: AdminKycView }>('POST', `/api/admin/kyc/${encodeURIComponent(id)}/${decision}`, {
          body: decision === 'reject' ? { reason } : {},
        })
      ).submission,
    withdrawals: (q: { status: 'open' | 'all'; cursor?: string; limit?: number }) =>
      request<Page<AdminWithdrawalView>>('GET', `/api/admin/withdrawals${qs(q)}`),
    withdrawalAction: async (id: string, action: 'approve' | 'reject' | 'refresh', note?: string) =>
      (
        await request<{ withdrawal: AdminWithdrawalView }>('POST', `/api/admin/withdrawals/${encodeURIComponent(id)}/${action}`, {
          body: action === 'reject' ? { note } : {},
        })
      ).withdrawal,
    users: (q: { q?: string; cursor?: string; limit?: number }) => request<Page<AdminUserView>>('GET', `/api/admin/users${qs(q)}`),
    /** Reuse `key` when retrying the same adjustment; the server applies it once. */
    adjust: (userId: string, deltaCents: number, note: string, key: string) =>
      request<{ user: AdminUserView; ledgerId: string }>('POST', `/api/admin/users/${encodeURIComponent(userId)}/credit`, {
        body: { deltaCents, note },
        headers: { [IDEMPOTENCY_HEADER]: key },
      }),
    setBlocked: async (userId: string, blocked: boolean) =>
      (
        await request<{ user: AdminUserView }>('POST', `/api/admin/users/${encodeURIComponent(userId)}/block`, {
          body: { blocked },
        })
      ).user,
    assets: async () => (await request<{ assets: AdminAssetView[] }>('GET', '/api/admin/assets')).assets,
    updateAsset: async (id: number, patch: AdminAssetPatch) =>
      (await request<{ asset: AdminAssetView }>('PATCH', `/api/admin/assets/${id}`, { body: patch })).asset,
    audit: (q: { action?: AuditAction; cursor?: string; limit?: number }) =>
      request<Page<AuditEntryView>>('GET', `/api/admin/audit${qs(q)}`),
    /** Active OTC price override (or null) and the assets that accept one. */
    otcOverride: async () => {
      const sentAt = Date.now();
      const r = await request<OtcOverrideState>('GET', '/api/admin/otc-override');
      serverClock.observe(r.serverNowMs, sentAt, Date.now());
      return r;
    },
    applyOtcOverride: async (input: OtcOverrideInput) =>
      (await request<{ override: OtcOverrideView }>('POST', '/api/admin/otc-override', { body: input })).override,
    releaseOtcOverride: async () => (await request<{ released: boolean }>('DELETE', '/api/admin/otc-override')).released,
  },

  /**
   * Places an order. A network failure is retried once with the same Idempotency-Key, so a
   * request that reached the server but lost its answer never opens a second order.
   */
  async createOrder(input: CreateOrderRequest, key: string = newIdempotencyKey()): Promise<OrderView> {
    const opts = { body: input, headers: { [IDEMPOTENCY_HEADER]: key } };
    const sentAt = Date.now();
    let r: { order: OrderView };
    try {
      r = await request<{ order: OrderView }>('POST', '/api/orders', opts);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== NETWORK_ERROR) throw err;
      r = await request<{ order: OrderView }>('POST', '/api/orders', opts);
    }
    // opensAt is the server clock at creation, with µs precision: a better sample than Date.
    serverClock.observe(parseServerTime(r.order.opensAt), sentAt, Date.now());
    return r.order;
  },
};
