import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AccountKind, AssetView, OrderLimitsView, WalletView } from '@traderoom/shared';
import { api, ApiError, SESSION_EXPIRED_EVENT } from './api';
import { defaultFeedUrl, PriceFeed, type FeedStatus, type Quote } from './feed';

export type Loadable<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

interface SessionData {
  feed: PriceFeed;
  /** The account being traded on (real or demo); remembered per browser. */
  account: AccountKind;
  setAccount(account: AccountKind): void;
  /** Both balances, real first. */
  accounts: Loadable<WalletView[]>;
  /** The selected account's balance. */
  wallet: Loadable<WalletView>;
  refreshWallet(): Promise<void>;
  refillDemo(): Promise<void>;
  catalog: Loadable<{ assets: AssetView[]; limits: OrderLimitsView }>;
  reloadCatalog(): void;
}

const Ctx = createContext<SessionData | null>(null);

const ACCOUNT_KEY = 'traderoom:account';

/** New visitors start on the demo account, as the US$ 10.000 there is free to practise with. */
export function readAccount(): AccountKind {
  try {
    return localStorage.getItem(ACCOUNT_KEY) === 'real' ? 'real' : 'demo';
  } catch {
    return 'demo';
  }
}

function writeAccount(account: AccountKind): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, account);
  } catch {
    // Private mode: the choice lasts until the page reloads.
  }
}

/** Everything the signed-in pages share: the price feed, the wallet and the asset catalog. */
export function SessionDataProvider({ children }: { children: ReactNode }) {
  const feedRef = useRef<PriceFeed | null>(null);
  feedRef.current ??= new PriceFeed({ url: defaultFeedUrl() });
  const feed = feedRef.current;

  useEffect(() => {
    feed.start();
    // 4401 from the gateway: confirm with the API (which fires the session-expired event) or retry.
    const off = feed.onStatus(() => {
      if (feed.getStatus() !== 'unauthorized') return;
      api.me().then(
        (user) => {
          if (user) setTimeout(() => feed.start(), 2000);
          else window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
        },
        () => setTimeout(() => feed.start(), 5000),
      );
    });
    return () => {
      off();
      feed.stop();
    };
  }, [feed]);

  const [account, setAccountState] = useState<AccountKind>(readAccount);
  const setAccount = useCallback((a: AccountKind) => {
    writeAccount(a);
    setAccountState(a);
  }, []);

  const [accounts, setAccounts] = useState<Loadable<WalletView[]>>({ status: 'loading' });
  const refreshWallet = useCallback(async () => {
    try {
      setAccounts({ status: 'ready', data: await api.accounts() });
    } catch (err) {
      // Keep showing the last balance on a transient failure.
      setAccounts((cur) => (cur.status === 'ready' ? cur : { status: 'error', message: errorMessage(err, 'Erro ao carregar o saldo.') }));
    }
  }, []);
  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);
  const refillDemo = useCallback(async () => {
    await api.refillDemo();
    await refreshWallet();
  }, [refreshWallet]);

  const wallet = useMemo((): Loadable<WalletView> => {
    if (accounts.status !== 'ready') return accounts;
    const w = accounts.data.find((x) => x.account === account);
    return w ? { status: 'ready', data: w } : { status: 'error', message: 'Conta não encontrada.' };
  }, [accounts, account]);

  const [catalog, setCatalog] = useState<SessionData['catalog']>({ status: 'loading' });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.assets().then(
      (r) => !cancelled && setCatalog({ status: 'ready', data: r }),
      (err: unknown) => !cancelled && setCatalog({ status: 'error', message: errorMessage(err, 'Erro ao carregar os ativos.') }),
    );
    return () => {
      cancelled = true;
    };
  }, [catalogAttempt]);
  const reloadCatalog = useCallback(() => {
    setCatalog({ status: 'loading' });
    setCatalogAttempt((n) => n + 1);
  }, []);

  const value = useMemo(
    () => ({ feed, account, setAccount, accounts, wallet, refreshWallet, refillDemo, catalog, reloadCatalog }),
    [feed, account, setAccount, accounts, wallet, refreshWallet, refillDemo, catalog, reloadCatalog],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useSessionData(): SessionData {
  const ctx = use(Ctx);
  if (!ctx) throw new Error('useSessionData outside SessionDataProvider');
  return ctx;
}

/** Live quote for one symbol; subscribing here is what makes the feed ask the gateway for it. */
export function useQuote(symbol: string | null): Quote | null {
  const { feed } = useSessionData();
  const subscribe = useCallback((cb: () => void) => (symbol ? feed.subscribe(symbol, cb) : () => {}), [feed, symbol]);
  return useSyncExternalStore(subscribe, () => (symbol ? feed.quote(symbol) : null));
}

export function useFeedStatus(): FeedStatus {
  const { feed } = useSessionData();
  const subscribe = useCallback((cb: () => void) => feed.onStatus(cb), [feed]);
  return useSyncExternalStore(subscribe, () => feed.getStatus());
}

/** Re-renders every `ms`; for countdowns. */
export function useNow(ms: number, now: () => number = Date.now): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), ms);
    return () => clearInterval(id);
  }, [ms, now]);
  return t;
}
