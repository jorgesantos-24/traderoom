import type { PaymentService } from '../src/services/payments.js';
import type { KycService } from '../src/services/kyc.js';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Registry, type PublicUser } from '@traderoom/shared';
import { buildApp, type AppDeps } from '../src/app.js';
import type { HealthDeps } from '../src/lib/health.js';
import type { Mailer } from '../src/lib/mailer.js';
import type { AuthService, SessionInfo } from '../src/services/auth.js';
import type { AdminService } from '../src/services/admin.js';
import type { AssetRepo, AssetRow } from '../src/services/assets.js';
import { DEFAULT_ORDER_LIMITS } from '../src/services/order-limits.js';
import type { CandleService } from '../src/services/candles.js';
import type { OrderService } from '../src/services/orders.js';
import type { WalletService } from '../src/services/wallet.js';
import type { OtcOverrideService } from '../src/services/otc-override.js';

export const okHealth: HealthDeps = {
  pingPostgres: async () => {},
  pingRedis: async () => {},
  getLastTickMs: async () => Date.now(),
  now: () => Date.now(),
  feedMaxAgeMs: 5000,
  timeoutMs: 50,
};

export const TEST_USER: PublicUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'user',
};

/** Cookie value accepted by fakeAuth; any other value is an invalid session. */
export const FAKE_SID = `22222222-2222-4222-8222-222222222222.${'a'.repeat(43)}`;
export const FAKE_ADMIN_SID = `33333333-3333-4333-8333-333333333333.${'b'.repeat(43)}`;

export function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    register: async (input) => ({ ...TEST_USER, email: input.email, name: input.name }),
    login: async () => ({ user: TEST_USER, cookieValue: FAKE_SID }),
    resolveSession: async (value): Promise<SessionInfo | null> => {
      if (value === FAKE_SID) return { sessionId: 'fake', user: TEST_USER };
      if (value === FAKE_ADMIN_SID) return { sessionId: 'fake-admin', user: { ...TEST_USER, role: 'admin' } };
      return null;
    },
    logout: async () => {},
    requestPasswordReset: async () => null,
    resetPassword: async () => {},
    ...overrides,
  };
}

/** Default candle service for tests that do not exercise /api/candles. */
export const emptyCandles: CandleService = { get: async () => [], warmOnce: async () => {}, startWarming: () => () => {} };

const notUsed = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not wired in this test`);
};

export const unusedOrders: OrderService = { create: notUsed('orders.create'), list: notUsed('orders.list') };
export const unusedWallet: WalletService = {
  get: notUsed('wallet.get'),
  all: notUsed('wallet.all'),
  refillDemo: notUsed('wallet.refillDemo'),
  ledger: notUsed('wallet.ledger'),
};
export const unusedPayments: PaymentService = {
  info: notUsed('payments.info'),
  createDeposit: notUsed('payments.createDeposit'),
  getDeposit: notUsed('payments.getDeposit'),
  listDeposits: notUsed('payments.listDeposits'),
  requestWithdrawal: notUsed('payments.requestWithdrawal'),
  listWithdrawals: notUsed('payments.listWithdrawals'),
  cancelWithdrawal: notUsed('payments.cancelWithdrawal'),
  adminList: notUsed('payments.adminList'),
  approve: notUsed('payments.approve'),
  reject: notUsed('payments.reject'),
  refreshWithdrawal: notUsed('payments.refreshWithdrawal'),
  handleWebhook: notUsed('payments.handleWebhook'),
  syncOpen: notUsed('payments.syncOpen'),
  applyChargeState: notUsed('payments.applyChargeState'),
  applyPayoutState: notUsed('payments.applyPayoutState'),
};
export const unusedKyc: KycService = {
  state: notUsed('kyc.state'),
  uploadFile: notUsed('kyc.uploadFile'),
  submit: notUsed('kyc.submit'),
  requireApproved: notUsed('kyc.requireApproved'),
  adminList: notUsed('kyc.adminList'),
  adminGet: notUsed('kyc.adminGet'),
  adminFile: notUsed('kyc.adminFile'),
  approve: notUsed('kyc.approve'),
  reject: notUsed('kyc.reject'),
};
export const unusedAdmin: AdminService = {
  listUsers: notUsed('admin.listUsers'),
  adjustBalance: notUsed('admin.adjustBalance'),
  setBlocked: notUsed('admin.setBlocked'),
  listAssets: notUsed('admin.listAssets'),
  updateAsset: notUsed('admin.updateAsset'),
  listAudit: notUsed('admin.listAudit'),
  allowedIndicators: notUsed('admin.allowedIndicators'),
  listIndicatorAccess: notUsed('admin.listIndicatorAccess'),
  grantIndicator: notUsed('admin.grantIndicator'),
  revokeIndicator: notUsed('admin.revokeIndicator'),
};

export const unusedOtcOverride: OtcOverrideService = {
  get: notUsed('otcOverride.get'),
  apply: notUsed('otcOverride.apply'),
  release: notUsed('otcOverride.release'),
  publicState: notUsed('otcOverride.publicState'),
  exposure: notUsed('otcOverride.exposure'),
};

export function fakeAssets(
  input: Array<Omit<AssetRow, 'kind' | 'category'> & Partial<Pick<AssetRow, 'kind' | 'category'>>> = [
    { id: 1, symbol: 'BTCUSDT', display: 'BTC/USD', payoutPct: 87 },
  ],
): AssetRepo {
  const list: AssetRow[] = input.map((a) => ({ kind: 'market', category: 'crypto', ...a }));
  const value = { bySymbol: new Map(list.map((a) => [a.symbol, a])), byId: new Map(list.map((a) => [a.id, a])) };
  return { enabled: async () => value, enabledSymbols: async () => new Set(list.map((a) => a.symbol)), invalidate: () => {} };
}

export interface SentMail {
  to: string;
  link: string;
}

export function captureMailer(): { mailer: Mailer; sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    mailer: {
      async sendPasswordReset(to, link) {
        sent.push({ to, link });
      },
    },
  };
}

export interface TestAppOptions {
  deps?: Partial<Omit<AppDeps, 'createMailer' | 'createCandles'>>;
  candles?: CandleService;
  mailer?: Mailer;
  redis?: Redis | null;
  nameSpace?: string;
  globalMax?: number;
  extend?: (app: FastifyInstance) => void;
}

export function testApp(o: TestAppOptions = {}): Promise<FastifyInstance> {
  const mailer = o.mailer ?? captureMailer().mailer;
  return buildApp(
    {
      health: o.deps?.health ?? okHealth,
      auth: o.deps?.auth ?? fakeAuth(),
      createMailer: () => mailer,
      createCandles: () => o.candles ?? emptyCandles,
      orders: o.deps?.orders ?? unusedOrders,
      wallet: o.deps?.wallet ?? unusedWallet,
      assets: o.deps?.assets ?? fakeAssets(),
      limits: o.deps?.limits ?? { get: async () => DEFAULT_ORDER_LIMITS },
      admin: o.deps?.admin ?? unusedAdmin,
      payments: o.deps?.payments ?? unusedPayments,
      kyc: o.deps?.kyc ?? unusedKyc,
      otcOverride: o.deps?.otcOverride ?? unusedOtcOverride,
      metrics: o.deps?.metrics ?? new Registry(),
    },
    {
      logger: false,
      publicOrigin: 'https://app.test',
      security: {
        cookieSecure: true,
        rateLimit: { redis: o.redis ?? null, nameSpace: o.nameSpace ?? 'rl-test:', globalMax: o.globalMax ?? 120 },
      },
      ...(o.extend ? { extend: o.extend } : {}),
    },
  );
}

/** Tiny cookie jar for app.inject: keeps name=value pairs from Set-Cookie. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(value));
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }
}
