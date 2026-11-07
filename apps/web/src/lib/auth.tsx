import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicUser } from '@traderoom/shared';
import { api, ApiError, refreshCsrf, SESSION_EXPIRED_EVENT, setCsrfToken } from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anon'; expired: boolean }
  | { status: 'authed'; user: PublicUser }
  | { status: 'error'; message: string };

interface AuthContextValue {
  state: AuthState;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await api.me();
        if (cancelled) return;
        if (user) await refreshCsrf();
        if (!cancelled) setState(user ? { status: 'authed', user } : { status: 'anon', expired: false });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof ApiError ? err.message : 'Não foi possível carregar sua sessão.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const onExpired = () => {
      setCsrfToken(null);
      setState((s) => (s.status === 'authed' ? { status: 'anon', expired: true } : s));
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const user = await api.login(email, password);
    setState({ status: 'authed', user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setCsrfToken(null);
      setState({ status: 'anon', expired: false });
    }
  }, []);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(() => ({ state, login, logout, retry }), [state, login, logout, retry]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function useUser(): PublicUser {
  const { state } = useAuth();
  if (state.status !== 'authed') throw new Error('useUser on a page without a session');
  return state.user;
}
