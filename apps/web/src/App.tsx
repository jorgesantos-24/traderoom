import { lazy, Suspense, useEffect } from 'react';
import { ErrorState, LoadingState } from './components/ui';
import { useAuth } from './lib/auth';
import { navigate, useLocation } from './lib/router';
import { SessionDataProvider } from './lib/session-data';
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from './pages/AuthPages';
import { NotFoundPage } from './pages/NotFoundPage';

// The signed-in area carries the chart library; the login screens load without it.
const TraderoomPage = lazy(() => import('./pages/TraderoomPage').then((m) => ({ default: m.TraderoomPage })));
const WalletPage = lazy(() => import('./pages/WalletPage').then((m) => ({ default: m.WalletPage })));
const VerificationPage = lazy(() => import('./pages/VerificationPage').then((m) => ({ default: m.VerificationPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

const PUBLIC = { '/login': LoginPage, '/register': RegisterPage, '/forgot': ForgotPage, '/reset': ResetPage } as const;
const PRIVATE = { '/traderoom': TraderoomPage, '/wallet': WalletPage, '/admin': AdminPage, '/verification': VerificationPage } as const;

const TITLES: Record<string, string> = {
  '/login': 'Entrar',
  '/register': 'Criar conta',
  '/forgot': 'Recuperar senha',
  '/reset': 'Nova senha',
  '/traderoom': 'Negociar',
  '/wallet': 'Carteira',
  '/admin': 'Admin',
  '/verification': 'Verificação de conta',
};

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export function App() {
  const { state, retry } = useAuth();
  const { pathname, search } = useLocation();

  useEffect(() => {
    const t = TITLES[pathname];
    document.title = t ? `${t} · Kyden` : 'Kyden';
  }, [pathname]);

  if (state.status === 'loading') return <LoadingState label="Carregando…" className="h-full" />;
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={retry} className="h-full" />;

  // History is now a side panel; old links land on the trading screen.
  if (pathname === '/history') return <Redirect to="/traderoom" />;
  if (pathname === '/') return <Redirect to={state.status === 'authed' ? '/traderoom' : '/login'} />;

  const Public = PUBLIC[pathname as keyof typeof PUBLIC];
  if (Public) {
    // Signed-in users skip login/register; reset stays reachable (the link may be for another account).
    if (state.status === 'authed' && pathname !== '/reset') return <Redirect to="/traderoom" />;
    return <Public />;
  }

  const Private = PRIVATE[pathname as keyof typeof PRIVATE];
  if (Private) {
    if (state.status !== 'authed') {
      const next = encodeURIComponent(pathname + (search.size > 0 ? `?${search}` : ''));
      return <Redirect to={`/login?next=${next}`} />;
    }
    return (
      // Keyed by user so nothing from a previous session (feed, wallet) survives a re-login.
      <SessionDataProvider key={state.user.id}>
        <Suspense fallback={<LoadingState label="Carregando…" className="h-full" />}>
          <Private />
        </Suspense>
      </SessionDataProvider>
    );
  }

  return <NotFoundPage />;
}
