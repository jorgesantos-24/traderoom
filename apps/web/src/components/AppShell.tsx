import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth, useUser } from '../lib/auth';
import { serverClock } from '../lib/clock';
import { TIME_ZONE } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { isSoundMuted, setSoundMuted } from '../lib/sound';
import { HistoryDrawer } from './HistoryDrawer';
import { AccountSwitcher, DepositButton, ProfileMenu } from './AccountMenu';
import { cx } from './ui';

export const SUPPORT_EMAIL = 'support@kydeninvest.com';

/** Filled icons, like the Kyden platform's sidebar. */
const ICONS: Record<string, ReactNode> = {
  portfolio: (
    <path d="M9 4h6a2 2 0 0 1 2 2v1h3a1 1 0 0 1 1 1v4H3V8a1 1 0 0 1 1-1h3V6a2 2 0 0 1 2-2zm0 3h6V6H9v1zM3 13.5h7v1.5h4v-1.5h7V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5.5z" />
  ),
  history: <path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm-1 4v6l5 3 1-1.6-4-2.4V7h-2z" />,
  performance: <path d="M3 4h8v7H3V4zm10 0h8v7h-8V4zM3 13h8v7H3v-7zm10 0h8v7h-8v-7z" />,
  chat: <path d="M4 3h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm3 5v2h10V8H7zm0 3.5v2h7v-2H7z" />,
  videos: <path d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zm0 2a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM10 8l6 4-6 4V8z" />,
  promo: (
    <path d="M14.5 3.5l6 6-2 1-1.2-1.2-6.8 6.8.7 3.4-1.5 1.5-3.2-3.2-3.3 3.3-1.4-1.4 3.3-3.3L2 13.3l1.5-1.5 3.4.7 6.8-6.8-1.2-1.2 2-1z" />
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
    </>
  ),
  admin: <path d="M12 2l8 3.5v6c0 5-3.4 9-8 10.5C7.4 20.5 4 16.5 4 11.5v-6L12 2z" />,
  // Phone bottom bar keeps outline icons.
  '/traderoom': (
    <path
      d="M4 19V5m0 14h16M8 15l3-4 3 2 5-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  '/wallet': (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14.5h2" />
    </g>
  ),
};

function NavIcon({ name, className = 'size-6' }: { name: string; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="currentColor">
      {ICONS[name]}
    </svg>
  );
}

type Panel = 'portfolio' | 'support' | 'videos' | 'promo' | 'more';

const PANEL_TITLE: Record<Panel, string> = {
  portfolio: 'Portfólio total',
  support: 'Suporte',
  videos: 'Vídeo Tutoriais',
  promo: 'Promoção',
  more: 'Mais',
};

/** Sidebar entry: icon over an uppercase two-line label. */
const sideItemCls = (active: boolean) =>
  cx(
    'relative flex h-[78px] w-full flex-col items-center justify-center gap-1.5 px-1 text-center text-[9.5px] leading-[1.35] font-medium tracking-[0.02em] uppercase transition-colors',
    active ? 'bg-[#1d242f] text-text' : 'text-muted hover:text-text',
  );

/** Bottom tab bar on phones. */
const tabItemCls = (active: boolean) =>
  cx(
    'flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 pt-2 pb-1.5 text-[11px] font-medium',
    active ? 'text-up' : 'text-muted hover:text-text',
  );

/**
 * Kyden platform layout: header on top, icon sidebar on the left with an optional side panel
 * next to it, the page, and the status footer at the bottom. `fullBleed` lets a page (the
 * traderoom) use the whole window; `headerExtra` sits next to the logo (the asset tabs);
 * `portfolio` is what the "Portfólio total" panel shows (the open positions).
 */
export function AppShell({
  children,
  banner,
  headerExtra,
  portfolio,
  fullBleed = false,
}: {
  children: ReactNode;
  banner?: ReactNode;
  headerExtra?: ReactNode;
  portfolio?: ReactNode;
  fullBleed?: boolean;
}) {
  const user = useUser();
  const { logout } = useAuth();
  const { pathname } = useLocation();
  const [leaving, setLeaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openHistory = useCallback(() => {
    setPanel(null);
    setHistoryOpen(true);
  }, []);
  const togglePanel = (p: Panel) => {
    setHistoryOpen(false);
    setPanel((cur) => (cur === p ? null : p));
  };

  const onLogout = async () => {
    setLeaving(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  const isAdmin = pathname.startsWith('/admin');

  return (
    <div className={cx('flex flex-col bg-bg', fullBleed ? 'h-full' : 'min-h-full')}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-up focus:px-3 focus:py-2 focus:text-white"
      >
        Pular para o conteúdo
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-bg">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 sm:gap-x-3 sm:px-3 md:h-[73px] md:flex-nowrap md:py-0 md:pr-[10px] md:pl-0">
          <Link href="/traderoom" className="flex shrink-0 items-center md:w-[160px] md:pl-[18px]" aria-label="Kyden — início">
            <img src="/brand/kyden-mark.png" alt="" className="size-8 md:size-9" />
            <span className="ml-3 hidden flex-col leading-none md:flex" aria-hidden="true">
              <span className="text-[13px] font-bold tracking-[0.06em] text-[#9aa0a8]">KYDEN</span>
              <span className="mt-[2px] text-[4.5px] font-semibold tracking-[0.18em] text-[#6d737b]">FINANCIAL MARKETS</span>
            </span>
          </Link>
          {/* Phones: wraps to a full-width second row; desktop: next to the logo. */}
          {headerExtra && (
            <div className="order-last flex min-w-0 basis-full items-center gap-2 md:order-none md:flex-1 md:basis-auto md:gap-3">
              {headerExtra}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
            <ProfileMenu user={user} onOpenHistory={openHistory} onLogout={() => void onLogout()} leaving={leaving} />
            <AccountSwitcher />
            <DepositButton />
          </div>
        </div>
        {banner}
      </header>
      <div className="relative flex min-h-0 flex-1">
        <nav aria-label="Principal" className="kd-sidebar relative z-50 hidden w-[74px] shrink-0 flex-col items-stretch md:flex">
          <SideButton
            label="Portfólio total"
            icon="portfolio"
            active={panel === 'portfolio'}
            onClick={() => (portfolio ? togglePanel('portfolio') : navigate('/traderoom'))}
          />
          <SideButton
            label="Histórico de trading"
            icon="history"
            active={historyOpen}
            expanded={historyOpen}
            controls="history-drawer"
            onClick={() => {
              setPanel(null);
              setHistoryOpen((v) => !v);
            }}
          />
          <Link
            href="/analises"
            aria-current={pathname === '/analises' ? 'page' : undefined}
            onClick={() => {
              closeHistory();
              setPanel(null);
            }}
            className={sideItemCls(pathname === '/analises' && !historyOpen && panel === null)}
          >
            <span className="relative">
              <NavIcon name="performance" />
              <span className="absolute -top-2 left-3 rounded-full bg-up px-1 text-[8px] leading-[13px] font-bold text-white normal-case">
                NEW
              </span>
            </span>
            <span>
              Meu
              <br />
              desempenho
            </span>
          </Link>
          <SideButton label="Suporte" icon="chat" active={panel === 'support'} onClick={() => togglePanel('support')} />
          <SideButton label="Vídeo tutoriais" icon="videos" active={panel === 'videos'} onClick={() => togglePanel('videos')} />
          <SideButton label="Promoção" icon="promo" active={panel === 'promo'} onClick={() => togglePanel('promo')} />
          <SideButton label="Mais" icon="more" active={panel === 'more'} onClick={() => togglePanel('more')} />
          {user.role === 'admin' && (
            <Link
              href="/admin"
              aria-current={isAdmin ? 'page' : undefined}
              onClick={() => setPanel(null)}
              className={sideItemCls(isAdmin && panel === null && !historyOpen)}
            >
              <NavIcon name="admin" />
              Admin
            </Link>
          )}
        </nav>
        {panel && (
          <aside
            aria-label={PANEL_TITLE[panel]}
            className="relative z-40 hidden w-[256px] shrink-0 flex-col border-r border-border bg-bg md:flex"
          >
            <div className="flex h-[56px] shrink-0 items-center justify-between pr-4 pl-[18px]">
              <h2 className="text-[13px] font-normal text-text">{PANEL_TITLE[panel]}</h2>
              <button
                type="button"
                aria-label="Fechar painel"
                onClick={() => setPanel(null)}
                className="p-1 text-[#aeb2b8] hover:text-text"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M5 5l14 14M19 5L5 19" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              <PanelBody panel={panel} portfolio={portfolio} isAdmin={user.role === 'admin'} onNavigate={() => setPanel(null)} />
            </div>
          </aside>
        )}
        <div className="pointer-events-none absolute inset-y-0 right-0 left-0 overflow-hidden md:left-[74px]">
          <div className="pointer-events-auto contents">
            <HistoryDrawer open={historyOpen} onClose={closeHistory} />
          </div>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className={cx('min-w-0 flex-1 outline-none', fullBleed ? 'min-h-0' : 'mx-auto w-full max-w-[1440px] px-3 py-3 sm:px-4 sm:py-4')}
        >
          {children}
        </main>
      </div>
      <StatusFooter />
      <nav
        aria-label="Principal (celular)"
        className="sticky bottom-0 z-50 flex shrink-0 items-stretch justify-around border-t border-border bg-bg pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <Link
          href="/traderoom"
          aria-current={pathname === '/traderoom' ? 'page' : undefined}
          onClick={closeHistory}
          className={tabItemCls(pathname === '/traderoom' && !historyOpen)}
        >
          <NavIcon name="/traderoom" className="size-5" />
          Negociar
        </Link>
        <Link
          href="/wallet"
          aria-current={pathname === '/wallet' ? 'page' : undefined}
          onClick={closeHistory}
          className={tabItemCls(pathname === '/wallet' && !historyOpen)}
        >
          <NavIcon name="/wallet" className="size-5" />
          Carteira
        </Link>
        <Link
          href="/analises"
          aria-current={pathname === '/analises' ? 'page' : undefined}
          onClick={closeHistory}
          className={tabItemCls(pathname === '/analises' && !historyOpen)}
        >
          <NavIcon name="performance" className="size-5" />
          Desempenho
        </Link>
        <button
          type="button"
          aria-expanded={historyOpen}
          aria-controls="history-drawer"
          onClick={() => setHistoryOpen((v) => !v)}
          className={tabItemCls(historyOpen)}
        >
          <NavIcon name="history" className="size-5" />
          Histórico
        </button>
        {user.role === 'admin' && (
          <Link
            href="/admin"
            aria-current={isAdmin ? 'page' : undefined}
            onClick={closeHistory}
            className={tabItemCls(isAdmin && !historyOpen)}
          >
            <NavIcon name="admin" className="size-5" />
            Admin
          </Link>
        )}
      </nav>
    </div>
  );
}

function SideButton({
  label,
  icon,
  active,
  onClick,
  expanded,
  controls,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick(): void;
  expanded?: boolean;
  controls?: string;
}) {
  const [first, ...rest] = label.split(' ');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
      className={sideItemCls(active)}
    >
      <NavIcon name={icon} />
      <span aria-hidden="true">
        {first}
        {rest.length > 0 && (
          <>
            <br />
            {rest.join(' ')}
          </>
        )}
      </span>
    </button>
  );
}

function PanelBody({
  panel,
  portfolio,
  isAdmin,
  onNavigate,
}: {
  panel: Panel;
  portfolio: ReactNode;
  isAdmin: boolean;
  onNavigate(): void;
}) {
  const linkCls = 'flex items-center rounded-control px-3 py-2.5 text-[13px] text-text hover:bg-field';
  switch (panel) {
    case 'portfolio':
      return <>{portfolio}</>;
    case 'support':
      return (
        <div className="flex flex-col gap-3 px-1.5 text-[13px] text-muted">
          <p>Fale com o suporte por e-mail. Atendemos todo dia, a toda hora.</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="rounded-control bg-[#c14331] px-3 py-2.5 text-center text-xs font-bold text-white uppercase hover:brightness-110"
          >
            Suporte
          </a>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-text hover:underline">
            {SUPPORT_EMAIL}
          </a>
        </div>
      );
    case 'videos':
      return null;
    case 'promo':
      return <p className="px-1.5 text-[13px] text-muted">Nenhuma promoção ativa no momento.</p>;
    case 'more':
      return (
        <div className="flex flex-col gap-0.5">
          <Link href="/wallet" onClick={onNavigate} className={linkCls}>
            Carteira
          </Link>
          <Link href="/verification" onClick={onNavigate} className={linkCls}>
            Verificação de conta
          </Link>
          <Link href="/analises" onClick={onNavigate} className={linkCls}>
            Meu desempenho
          </Link>
          {isAdmin && (
            <Link href="/admin" onClick={onNavigate} className={linkCls}>
              Admin
            </Link>
          )}
        </div>
      );
  }
}

const FOOTER_FMT = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: TIME_ZONE,
  timeZoneName: 'shortOffset',
});

/** "9 NOVEMBRO, 19:57:05" and "(UTC-3)", in Brasília time like the chart. */
export function footerClock(ms: number): { text: string; zone: string } {
  const parts = Object.fromEntries(FOOTER_FMT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const zone = `(${(parts['timeZoneName'] ?? 'GMT').replace('GMT', 'UTC')})`;
  return {
    text: `${parts['day']} ${(parts['month'] ?? '').toUpperCase()}, ${parts['hour']}:${parts['minute']}:${parts['second']}`,
    zone,
  };
}

/** Bottom status bar: support, sound, full screen and the current time. */
function StatusFooter() {
  const [now, setNow] = useState(() => serverClock.serverNow());
  const [muted, setMuted] = useState(isSoundMuted);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(serverClock.serverNow()), 1000);
    const onFs = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearInterval(id);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);
  const clock = footerClock(now);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <footer className="hidden h-[36px] shrink-0 items-center gap-3 bg-bg pr-3 pl-3 text-[13px] md:flex">
      <span className="flex items-center gap-1.5 text-[#c9ccd0]">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[15px]" fill="currentColor">
          <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm.1 13.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zM12 6c-2 0-3.5 1.2-3.6 3.1h2.2c.1-.8.6-1.2 1.4-1.2.8 0 1.3.5 1.3 1.1 0 .6-.3.9-1.1 1.4-.9.6-1.3 1.2-1.2 2.4v.5h2.1v-.4c0-.7.3-1 1.1-1.5.9-.6 1.5-1.3 1.5-2.4C15.7 7.2 14.2 6 12 6z" />
        </svg>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:underline">
          {SUPPORT_EMAIL}
        </a>
      </span>
      <div className="ml-auto flex items-center gap-5 text-[#9ea2a8]">
        <button
          type="button"
          aria-label={muted ? 'Ligar som' : 'Desligar som'}
          aria-pressed={muted}
          title={muted ? 'Ligar som' : 'Desligar som'}
          onClick={() => {
            setSoundMuted(!muted);
            setMuted(!muted);
          }}
          className="hover:text-text"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <path d="M3 9h4l5-4v14l-5-4H3V9z" />
            {muted ? (
              <path d="M16 9l5 6m0-6l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path
                d="M15 8.5a5 5 0 0 1 0 7M17.5 6a8.5 8.5 0 0 1 0 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
        <Link href="/verification" aria-label="Configurações da conta" title="Configurações da conta" className="hover:text-text">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <path
              d="M10.3 2h3.4l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.7 2.9-2 1.8c.1.6.1 1.2 0 1.8l2 1.8-1.7 2.9-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.4l-.5-2.6a7 7 0 0 1-1.7-.9l-2.5.9-1.7-2.9 2-1.8a6 6 0 0 1 0-1.8l-2-1.8 1.7-2.9 2.5.9c.5-.4 1.1-.7 1.7-.9l.5-2.6zM12 8.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
              transform="translate(0 1)"
            />
          </svg>
        </Link>
        <span className="tabular whitespace-nowrap">
          <span className="text-[#767b82]">HORA ATUAL: </span>
          <span className="text-text">{clock.text}</span> <span className="text-[#767b82]">{clock.zone}</span>
        </span>
        <button
          type="button"
          aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'}
          title={full ? 'Sair da tela cheia' : 'Tela cheia'}
          onClick={toggleFull}
          className="hover:text-text"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M4 4l5 5M20 4l-5 5M20 20l-5-5M4 20l5-5" />
          </svg>
        </button>
      </div>
    </footer>
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
