import { useCallback, useEffect } from 'react';
import type { LedgerEntryView } from '@traderoom/shared';
import { AppShell } from '../components/AppShell';
import { PagedFooter } from '../components/PagedFooter';
import { PaymentsHistory } from '../components/Payments';
import { Card, cx, EmptyState, ErrorState, LoadingState } from '../components/ui';
import { api } from '../lib/api';
import { ACCOUNT_LABEL, formatDateTime, formatMoney, formatSignedMoney, LEDGER_LABEL } from '../lib/format';
import { useSessionData } from '../lib/session-data';
import { usePaged } from '../lib/use-paged';

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="tabular text-2xl font-semibold" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function WalletPage() {
  const { account, wallet, refreshWallet } = useSessionData();
  const fetchPage = useCallback((cursor?: string) => api.ledger(account, cursor, 50), [account]);
  const ledger = usePaged<LedgerEntryView>(fetchPage, `ledger:${account}`);

  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold">Carteira — {ACCOUNT_LABEL[account]}</h1>
      <Card className="mb-4">
        {wallet.status === 'loading' && <LoadingState label="Carregando saldo…" />}
        {wallet.status === 'error' && <ErrorState message={wallet.message} onRetry={() => void refreshWallet()} />}
        {wallet.status === 'ready' && (
          <dl className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat label="Saldo disponível" value={formatMoney(wallet.data.balanceCents)} testId="wallet-balance" />
            <Stat label="Em ordens abertas" value={formatMoney(wallet.data.openStakeCents)} />
            <Stat label="Ordens abertas" value={String(wallet.data.openOrders)} />
          </dl>
        )}
      </Card>

      {account === 'real' && <PaymentsHistory />}

      <Card aria-labelledby="ledger-title">
        <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
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
              <thead className="text-left text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Data</th>
                  <th scope="col" className="px-4 py-2 font-medium">Tipo</th>
                  <th scope="col" className="px-4 py-2 font-medium">Descrição</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Valor</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Saldo após</th>
                </tr>
              </thead>
              <tbody>
                {ledger.items.map((e) => (
                  <tr key={e.id} className="border-t border-border" data-testid="ledger-row">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{LEDGER_LABEL[e.kind]}</td>
                    <td className="px-4 py-2 text-muted">{e.note ?? (e.orderId ? `Ordem ${e.orderId.slice(0, 8)}` : '—')}</td>
                    <td className={cx('tabular whitespace-nowrap px-4 py-2 text-right font-medium', e.deltaCents > 0 ? 'text-up' : e.deltaCents < 0 ? 'text-down' : '')}>
                      {formatSignedMoney(e.deltaCents)}
                    </td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(e.balanceAfterCents)}</td>
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
