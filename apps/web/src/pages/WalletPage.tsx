import { useCallback, useEffect } from 'react';
import type { LedgerEntryView } from '@traderoom/shared';
import { AppShell } from '../components/AppShell';
import { PagedFooter } from '../components/PagedFooter';
import { PaymentsHistory } from '../components/Payments';
import { Card, cx, EmptyState, ErrorState, LoadingState } from '../components/ui';
import { api } from '../lib/api';
import { ACCOUNT_LABEL, formatDateTime, formatMoney, formatSignedMoney, LEDGER_LABEL } from '../lib/format';
import { useHideBalances } from '../lib/hide-balance';
import { useSessionData } from '../lib/session-data';
import { usePaged } from '../lib/use-paged';

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className="grid size-11 shrink-0 place-items-center rounded-control border border-border bg-field text-brand">
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
          {icon}
        </svg>
      </span>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
        <dd className="tabular text-xl font-bold">{value}</dd>
      </div>
    </Card>
  );
}

export function WalletPage() {
  const { account, wallet, refreshWallet } = useSessionData();
  const hide = useHideBalances();
  const fetchPage = useCallback((cursor?: string) => api.ledger(account, cursor, 50), [account]);
  const ledger = usePaged<LedgerEntryView>(fetchPage, `ledger:${account}`);

  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Carteira</h1>
          <p className="text-sm text-muted">Seu saldo, depósitos, saques e tudo o que movimentou a conta.</p>
        </div>
        <span
          className={cx(
            'rounded-full border px-3 py-1 text-xs font-semibold',
            account === 'real' ? 'border-up/30 bg-up/10 text-up' : 'border-warn/30 bg-warn/10 text-warn',
          )}
        >
          {ACCOUNT_LABEL[account]}
        </span>
      </div>
      {wallet.status === 'loading' && (
        <Card className="mb-4">
          <LoadingState label="Carregando saldo…" />
        </Card>
      )}
      {wallet.status === 'error' && (
        <Card className="mb-4">
          <ErrorState message={wallet.message} onRetry={() => void refreshWallet()} />
        </Card>
      )}
      {wallet.status === 'ready' && (
        <dl className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="relative overflow-hidden p-6">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-[radial-gradient(circle,rgb(0_216_232/0.22),transparent_65%)]"
            />
            <dt className="relative flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted uppercase">
              Saldo disponível
              <button
                type="button"
                onClick={hide.toggle}
                className="-my-1 rounded-control p-1.5 hover:bg-field hover:text-text"
                aria-label={hide.hidden ? 'Mostrar saldos' : 'Ocultar saldos'}
                aria-pressed={hide.hidden}
                title={hide.hidden ? 'Mostrar saldos' : 'Ocultar saldos'}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-[18px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {hide.hidden ? (
                    <>
                      <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
                      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
                    </>
                  ) : (
                    <>
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
              </button>
            </dt>
            <dd className="tabular relative mt-1 text-4xl font-bold tracking-tight" data-testid="wallet-balance">
              {hide.money(wallet.data.balanceCents)}
            </dd>
          </Card>
          <Stat
            label="Em ordens abertas"
            value={formatMoney(wallet.data.openStakeCents)}
            icon={
              <>
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </>
            }
          />
          <Stat label="Ordens abertas" value={String(wallet.data.openOrders)} icon={<path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-6" />} />
        </dl>
      )}

      {account === 'real' && <PaymentsHistory />}

      <Card aria-labelledby="ledger-title">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border px-4 py-3">
          <h2 id="ledger-title" className="text-base font-semibold">
            Movimentações
          </h2>
          <span className="text-xs text-muted">Tudo o que entrou e saiu desta conta.</span>
        </div>
        {ledger.status === 'loading' && <LoadingState label="Carregando movimentações…" />}
        {ledger.status === 'error' && <ErrorState message={ledger.error ?? ''} onRetry={ledger.reload} />}
        {ledger.status === 'ready' && ledger.items.length === 0 && (
          <EmptyState title="Nenhuma movimentação ainda" hint="Quando houver créditos ou ordens, elas aparecem aqui." />
        )}
        {ledger.status === 'ready' && ledger.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Movimentações da carteira, mais recentes primeiro</caption>
              <thead className="text-left text-[11px] tracking-wider text-muted uppercase">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Data
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Tipo
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Descrição
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Valor
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Saldo após
                  </th>
                </tr>
              </thead>
              <tbody>
                {ledger.items.map((e) => (
                  <tr key={e.id} className="border-t border-border transition-colors hover:bg-field/50" data-testid="ledger-row">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{LEDGER_LABEL[e.kind]}</td>
                    <td className="px-4 py-2 text-muted">{e.note ?? (e.orderId ? `Ordem ${e.orderId.slice(0, 8)}` : '—')}</td>
                    <td
                      className={cx(
                        'tabular whitespace-nowrap px-4 py-2 text-right font-medium',
                        e.deltaCents > 0 ? 'text-up' : e.deltaCents < 0 ? 'text-down' : '',
                      )}
                    >
                      {formatSignedMoney(e.deltaCents)}
                    </td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right">{hide.money(e.balanceAfterCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PagedFooter paged={ledger} />
      </Card>
    </AppShell>
  );
}
