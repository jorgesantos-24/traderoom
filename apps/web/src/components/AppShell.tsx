import { useCallback, useState, type ReactNode } from 'react';
import { useAuth, useUser } from '../lib/auth';
import { Link, navigate, useLocation } from '../lib/router';
import { HistoryDrawer } from './HistoryDrawer';
import { AccountSwitcher, DepositButton, ProfileMenu } from './AccountMenu';
import { cx } from './ui';

const ICONS: Record<string, ReactNode> = {
  '/traderoom': <path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-6" />,
  '/wallet': (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14.5h2" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  '/admin': <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />,
};

const NAV = [
  { href: '/traderoom', label: 'Negociar' },
  { href: '/wallet', label: 'Carteira' },
];

const navItemCls = (active: boolean) =>
  cx(
    'flex flex-col items-center gap-1 rounded-control px-1 py-2.5 text-[11px] font-medium',
    active ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-field hover:text-text',
  );

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

/**
 * Header on top, main navigation in a left sidebar. `fullBleed` drops the centered
 * max width so a page (the traderoom) can use the whole window; `headerExtra` sits
 * next to the logo (the traderoom puts its asset tabs there).
 */
export function AppShell({
  children,
  banner,
  headerExtra,
  fullBleed = false,
}: {
  children: ReactNode;
  banner?: ReactNode;
  headerExtra?: ReactNode;
  fullBleed?: boolean;
}) {
  const user = useUser();
  const { logout } = useAuth();
  const { pathname } = useLocation();
  const [leaving, setLeaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openHistory = useCallback(() => setHistoryOpen(true), []);

  const onLogout = async () => {
    setLeaving(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className={cx('flex flex-col', fullBleed ? 'h-full' : 'min-h-full')}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-brand focus:px-3 focus:py-2 focus:text-bg"
      >
        Pular para o conteúdo
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="flex items-center gap-x-4 gap-y-2 px-4 py-2">
          <Link href="/traderoom" className="flex shrink-0 items-center" aria-label="Kyden — início">
            <img src="/brand/kyden-mark.png" alt="" className="size-8 rounded-md sm:hidden" />
            <img src="/brand/kyden-logo.png" alt="" className="hidden h-9 w-auto sm:block" />
          </Link>
          {headerExtra && <div className="flex min-w-0 flex-1 items-center gap-2">{headerExtra}</div>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ProfileMenu user={user} onOpenHistory={openHistory} onLogout={() => void onLogout()} leaving={leaving} />
            <AccountSwitcher />
            <DepositButton />
          </div>
        </div>
        {banner}
      </header>
      <div className="relative flex min-h-0 flex-1">
        <nav
          aria-label="Principal"
          className="relative z-50 flex w-[76px] shrink-0 flex-col items-stretch gap-1 border-r border-border bg-surface px-1.5 py-2"
        >
          {NAV.map((item) => {
            const active = pathname === item.href && !historyOpen;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                onClick={closeHistory}
                className={navItemCls(active)}
              >
                <NavIcon name={item.href} />
                {item.label}
              </Link>
            );
          })}
          <button
            type="button"
            aria-expanded={historyOpen}
            aria-controls="history-drawer"
            onClick={() => setHistoryOpen((v) => !v)}
            className={navItemCls(historyOpen)}
          >
            <NavIcon name="history" />
            Histórico
          </button>
          {user.role === 'admin' && (
            <Link
              href="/admin"
              aria-current={pathname === '/admin' ? 'page' : undefined}
              onClick={closeHistory}
              className={navItemCls(pathname === '/admin' && !historyOpen)}
            >
              <NavIcon name="/admin" />
              Admin
            </Link>
          )}
        </nav>
        <div className="pointer-events-none absolute inset-y-0 right-0 left-[76px] overflow-hidden">
          <div className="pointer-events-auto contents">
            <HistoryDrawer open={historyOpen} onClose={closeHistory} />
          </div>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className={cx('min-w-0 flex-1 outline-none', fullBleed ? 'min-h-0 p-2' : 'mx-auto max-w-[1440px] px-4 py-4')}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Fixed under the header while the selected asset (or the whole feed) has no fresh price. */
export function StaleBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="border-t border-warn/40 bg-warn/10 px-4 py-2 text-center text-sm text-warn" data-testid="stale-banner">
      {message}
    </div>
  );
}
