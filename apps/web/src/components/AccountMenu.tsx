import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ACCOUNT_KINDS, DEMO_START_CENTS, type AccountKind, type KycStatus, type PublicUser } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatMoney, KYC_STATUS_LABEL } from '../lib/format';
import { Link } from '../lib/router';
import { useHideBalances } from '../lib/hide-balance';
import { useSessionData } from '../lib/session-data';
import { DepositDialog, WithdrawDialog } from './Payments';
import { Spinner, cx } from './ui';

const KIND_LABEL: Record<AccountKind, string> = { real: 'Real', demo: 'Demo' };
/** Demo money in orange, real money in green, as on XGlobal. */
const KIND_TONE: Record<AccountKind, string> = {
  real: 'text-up',
  demo: 'text-warn',
};
const KYC_TONE: Record<KycStatus, string> = {
  none: 'bg-warn/15 text-warn',
  pending: 'bg-brand/15 text-brand',
  approved: 'bg-up/15 text-up',
  rejected: 'bg-down/15 text-down',
};

/** Closes a popover on Escape or a click outside `ref`. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

function Icon({ children, className = 'size-5' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const EYE = (
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>
);
const EYE_OFF = (
  <>
    <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </>
);

/**
 * Balance in the header with a dropdown to switch between the real and the demo account,
 * hide the balances, and refill the demo account to US$ 10.000.
 */
export function AccountSwitcher() {
  const { account, setAccount, accounts, wallet, refreshWallet, refillDemo } = useSessionData();
  const [open, setOpen] = useState(false);
  const { hidden, toggle: toggleHidden, money } = useHideBalances();
  const [refilling, setRefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  const refill = async () => {
    setRefilling(true);
    setError(null);
    try {
      await refillDemo();
      setAccount('demo');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível recarregar a conta demo.');
    } finally {
      setRefilling(false);
    }
  };

  if (wallet.status === 'loading') return <Spinner small label="Saldo" />;
  if (wallet.status === 'error') {
    return (
      <button type="button" onClick={() => void refreshWallet()} className="text-sm text-warn underline">
        Saldo indisponível — recarregar
      </button>
    );
  }
  const list = accounts.status === 'ready' ? accounts.data : [];
  const demo = list.find((a) => a.account === 'demo');
  const canRefill = demo !== undefined && demo.balanceCents < DEMO_START_CENTS;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={toggleHidden}
        className="rounded-control p-1.5 text-muted hover:bg-field hover:text-text"
        aria-label={hidden ? 'Mostrar saldos' : 'Ocultar saldos'}
        aria-pressed={hidden}
        title={hidden ? 'Mostrar saldos' : 'Ocultar saldos'}
        data-testid="hide-balance"
      >
        <Icon className="size-[18px]">{hidden ? EYE_OFF : EYE}</Icon>
      </button>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-control px-2 py-1 text-left leading-tight hover:bg-field"
        data-testid="account-switcher"
      >
        <span>
          <span className="block text-[10px] font-semibold tracking-wide text-muted uppercase" data-testid="account-kind">
            {KIND_LABEL[account]}
          </span>
          <span className={cx('tabular block text-base font-bold sm:text-lg', KIND_TONE[account])} data-testid="balance">
            {money(wallet.data.balanceCents)}
          </span>
        </span>
        <Icon className={cx('size-4 text-muted transition-transform', open && 'rotate-180')}>
          <path d="M6 9l6 6 6-6" />
        </Icon>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Contas"
          className="absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-card border border-border bg-field shadow-2xl"
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-1 text-xs text-muted">
            <span>Contas</span>
            <button
              type="button"
              onClick={toggleHidden}
              className={cx(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition-colors',
                hidden ? 'border-brand/40 bg-brand/10 text-brand' : 'border-border hover:border-muted hover:text-text',
              )}
              aria-pressed={hidden}
            >
              <Icon className="size-4">{hidden ? EYE_OFF : EYE}</Icon>
              {hidden ? 'Mostrar saldos' : 'Ocultar saldos'}
            </button>
          </div>
          {ACCOUNT_KINDS.map((kind) => {
            const w = list.find((a) => a.account === kind);
            const active = kind === account;
            return (
              <button
                key={kind}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setAccount(kind);
                  close();
                }}
                className={cx(
                  'flex w-full flex-col border-l-2 px-4 py-2.5 text-left',
                  active ? 'border-brand bg-bg/40' : 'border-transparent hover:bg-bg/30',
                )}
                data-testid={`account-${kind}`}
              >
                <span className="text-xs font-semibold tracking-wide uppercase">{KIND_LABEL[kind]}</span>
                <span className={cx('tabular text-base font-semibold', KIND_TONE[kind])}>{w ? money(w.balanceCents) : '—'}</span>
              </button>
            );
          })}
          <div className="p-3">
            <button
              type="button"
              onClick={() => void refill()}
              disabled={!canRefill || refilling}
              className="flex w-full items-center justify-center gap-2 rounded-control bg-border/70 px-3 py-2.5 text-sm font-medium hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
              title={canRefill ? undefined : `A conta demo já tem ${formatMoney(DEMO_START_CENTS)} ou mais.`}
            >
              {refilling && <Spinner small />}
              Recarregar demo
            </button>
            <p className="mt-1.5 text-center text-[11px] text-muted">Volta o saldo demo para {formatMoney(DEMO_START_CENTS)}.</p>
            {error && (
              <p role="alert" className="mt-1 text-center text-xs text-down">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function Avatar({ name, size }: { name: string; size: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/80 to-[#2962ff] font-bold text-bg',
        size === 'sm' ? 'size-9 text-sm' : 'size-16 text-xl ring-2 ring-warn ring-offset-2 ring-offset-surface',
      )}
    >
      {initials(name)}
    </span>
  );
}

function MenuItem({
  icon,
  children,
  ...rest
}: { icon: ReactNode; children: ReactNode } & ({ href: string; onClick?: () => void } | { href?: undefined; onClick: () => void })) {
  const cls = 'flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm hover:bg-field';
  const inner = (
    <>
      <Icon className="size-5 text-muted">{icon}</Icon>
      {children}
    </>
  );
  return rest.href !== undefined ? (
    <Link href={rest.href} onClick={rest.onClick} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={rest.onClick} className={cls}>
      {inner}
    </button>
  );
}

/** Avatar in the header that opens the profile panel from the right. */
export function ProfileMenu({
  user,
  onOpenHistory,
  onLogout,
  leaving,
}: {
  user: PublicUser;
  onOpenHistory(): void;
  onLogout(): void;
  leaving: boolean;
}) {
  const hideBalances = useHideBalances();
  const { account, accounts } = useSessionData();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [payment, setPayment] = useState<'deposit' | 'withdraw' | null>(null);
  const [kyc, setKyc] = useState<KycStatus | null>(null);
  const close = useCallback(() => setOpen(false), []);

  // Fresh each time the panel opens, so an approval shows up without a reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.kyc().then(
      (s) => !cancelled && setKyc(s.status),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const copyId = () => {
    void navigator.clipboard?.writeText(user.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const list = accounts.status === 'ready' ? accounts.data : [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Abrir perfil"
        className="rounded-full hover:opacity-90"
        data-testid="profile-button"
      >
        <Avatar name={user.name} size="sm" />
      </button>

      {/* Portal: the header's backdrop blur would otherwise trap this fixed panel inside it. */}
      {open &&
        createPortal(
          <>
            <div aria-hidden="true" onClick={close} className="fixed inset-0 z-[60] bg-bg/50" />
            <aside
              role="dialog"
              aria-label="Perfil"
              className="fixed inset-y-0 right-0 z-[61] flex w-[min(340px,100vw)] flex-col border-l border-border bg-surface shadow-2xl"
            >
              <div className="flex items-start gap-3 border-b border-border p-4">
                <Avatar name={user.name} size="lg" />
                <div className="min-w-0 flex-1 leading-snug">
                  <div className="truncate font-semibold" title={user.name}>
                    {user.name}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted">
                    <span className="truncate">ID: {user.id.slice(0, 13).toUpperCase()}…</span>
                    <button type="button" onClick={copyId} className="rounded p-1 hover:text-text" aria-label="Copiar ID">
                      <Icon className="size-3.5">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </Icon>
                    </button>
                    {copied && <span className="text-up">copiado</span>}
                  </div>
                  <div className="truncate text-xs text-muted" title={user.email}>
                    {user.email}
                  </div>
                </div>
                <button type="button" onClick={close} className="rounded p-1 text-muted hover:text-text" aria-label="Fechar perfil">
                  <Icon>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </Icon>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 border-b border-border p-4">
                {ACCOUNT_KINDS.map((kind) => {
                  const w = list.find((a) => a.account === kind);
                  return (
                    <div
                      key={kind}
                      className={cx('rounded-control border bg-field px-3 py-2', kind === account ? 'border-brand' : 'border-border')}
                    >
                      <div className="text-[10px] font-semibold tracking-wide text-muted uppercase">Conta {KIND_LABEL[kind]}</div>
                      <div className={cx('tabular text-sm font-bold', KIND_TONE[kind])}>{w ? hideBalances.money(w.balanceCents) : '—'}</div>
                    </div>
                  );
                })}
              </div>

              <nav aria-label="Menu do perfil" className="flex-1 overflow-y-auto p-3">
                <div className="px-3 pb-1 text-xs text-muted">Conta</div>
                <MenuItem
                  href="/verification"
                  onClick={close}
                  icon={
                    <>
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <circle cx="9" cy="11" r="2" />
                      <path d="M6 16c.5-1.5 1.7-2.2 3-2.2s2.5.7 3 2.2M15 10h3M15 13h3" />
                    </>
                  }
                >
                  <span className="flex-1 text-left">Verificação de conta</span>
                  {kyc && (
                    <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', KYC_TONE[kyc])} data-testid="kyc-badge">
                      {KYC_STATUS_LABEL[kyc]}
                    </span>
                  )}
                </MenuItem>
                <div className="px-3 pt-3 pb-1 text-xs text-muted">Financeiro</div>
                <MenuItem
                  onClick={() => {
                    close();
                    setPayment('deposit');
                  }}
                  icon={
                    <>
                      <rect x="3" y="6" width="18" height="13" rx="2" />
                      <path d="M12 9.5v6M9 12.5l3 3 3-3" />
                    </>
                  }
                >
                  Depósito
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    setPayment('withdraw');
                  }}
                  icon={
                    <>
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 15.5v-7M9 11.5l3-3 3 3" />
                    </>
                  }
                >
                  Saque
                </MenuItem>
                <MenuItem
                  href="/wallet"
                  onClick={close}
                  icon={
                    <>
                      <rect x="3" y="6" width="18" height="13" rx="2" />
                      <path d="M3 10h18M16 14.5h2" />
                    </>
                  }
                >
                  Carteira
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    onOpenHistory();
                  }}
                  icon={
                    <>
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 8v4l3 2" />
                    </>
                  }
                >
                  Histórico de operações
                </MenuItem>
                <MenuItem href="/analises" onClick={close} icon={<path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-6" />}>
                  Análises de operações
                </MenuItem>
                <MenuItem href="/wallet" onClick={close} icon={<path d="M7 4h10v16l-5-3-5 3V4zM10 9h4" />}>
                  Histórico de transações
                </MenuItem>
                {user.role === 'admin' && (
                  <>
                    <div className="px-3 pt-3 pb-1 text-xs text-muted">Outros</div>
                    <MenuItem href="/admin" onClick={close} icon={<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />}>
                      Administração
                    </MenuItem>
                  </>
                )}
              </nav>

              <div className="border-t border-border p-4">
                <button
                  type="button"
                  onClick={onLogout}
                  disabled={leaving}
                  className="flex w-full items-center justify-center gap-2 rounded-control border border-down/50 px-3 py-2.5 text-sm font-medium text-down hover:bg-down/10 disabled:opacity-50"
                >
                  {leaving && <Spinner small />}
                  Sair
                </button>
              </div>
            </aside>
          </>,
          document.body,
        )}
      <DepositDialog open={payment === 'deposit'} onClose={() => setPayment(null)} />
      <WithdrawDialog open={payment === 'withdraw'} onClose={() => setPayment(null)} />
    </>
  );
}

/** "Depositar" in the header, styled like XGlobal's; opens the Pix deposit. */
export function DepositButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 items-center gap-2.5 rounded-control bg-[linear-gradient(135deg,#34d672,#16a34a)] px-2.5 text-base font-bold text-bg shadow-[0_10px_28px_-12px_var(--color-up)] transition-[filter,transform] hover:brightness-110 active:scale-[0.98] sm:h-11 sm:px-5"
        data-testid="deposit-button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H17a1 1 0 0 1 1 1v2H6.5a.5.5 0 0 0 0 1H19a2 2 0 0 1 2 2v2h-4a3 3 0 0 0 0 6h4v1a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-12z" />
          <path d="M17 14h4v2h-4a1 1 0 0 1 0-2z" />
        </svg>
        <span className="hidden sm:inline">Depositar</span>
      </button>
      <DepositDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
