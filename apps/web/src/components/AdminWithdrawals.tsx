import { useCallback, useState } from 'react';
import type { AdminWithdrawalView } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatBrl, formatDateTime, formatFxRate, formatMoney, PIX_KEY_LABEL, WITHDRAWAL_STATUS_LABEL } from '../lib/format';
import { usePaged } from '../lib/use-paged';
import { Dialog } from './Dialog';
import { PagedFooter } from './PagedFooter';
import { Button, Card, cx, EmptyState, ErrorState, Field, FormMessage, LoadingState } from './ui';

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Pix withdrawals waiting for review. Approving sends the money through the gateway; rejecting returns it to the user. */
export function WithdrawalsTab({ onNotice }: { onNotice(m: string): void }) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const fetchPage = useCallback((cursor?: string) => api.admin.withdrawals({ status: filter, cursor, limit: 50 }), [filter]);
  const list = usePaged<AdminWithdrawalView>(fetchPage, `withdrawals:${filter}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AdminWithdrawalView | null>(null);
  const [rejecting, setRejecting] = useState<AdminWithdrawalView | null>(null);
  const [note, setNote] = useState('');

  const act = async (w: AdminWithdrawalView, action: 'approve' | 'reject' | 'refresh', reason?: string) => {
    setBusy(w.id);
    setError(null);
    try {
      const updated = await api.admin.withdrawalAction(w.id, action, reason);
      list.patch((x) => (x.id === updated.id ? updated : x));
      onNotice(`Saque de ${formatMoney(w.amountCents)} para ${w.userEmail}: ${WITHDRAWAL_STATUS_LABEL[updated.status]}.`);
      setConfirm(null);
      setRejecting(null);
      setNote('');
    } catch (err) {
      setError(errMsg(err, 'Não foi possível concluir a ação.'));
      setConfirm(null);
      list.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-sm text-muted">
          O valor já saiu do saldo do cliente. Aprovar envia o Pix pelo gateway de pagamento; recusar devolve o valor.
        </p>
        <div className="flex gap-1">
          {(['open', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cx('rounded-control px-3 py-1 text-sm', filter === f ? 'bg-field text-text' : 'text-muted hover:text-text')}
            >
              {f === 'open' ? 'Pendentes' : 'Todos'}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div className="p-3">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      )}
      {list.status === 'loading' && <LoadingState label="Carregando saques…" />}
      {list.status === 'error' && <ErrorState message={list.error ?? ''} onRetry={list.reload} />}
      {list.status === 'ready' && list.items.length === 0 && (
        <EmptyState title={filter === 'open' ? 'Nenhum saque pendente' : 'Nenhum saque'} />
      )}
      {list.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Pedidos de saque</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Data
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Cliente
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Chave Pix
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Valor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((w) => {
                const reviewable = w.status === 'requested' || w.status === 'approved';
                return (
                  <tr key={w.id} className="border-t border-border align-top" data-testid="withdrawal-row">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(w.createdAt)}</td>
                    <td className="px-4 py-2">
                      <div>{w.userName}</div>
                      <div className="text-xs text-muted">
                        {w.userEmail}
                        {w.userCpf ? ` · CPF ${w.userCpf}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-xs text-muted">{PIX_KEY_LABEL[w.pixKeyType]}</div>
                      <div className="break-all">{w.pixKey}</div>
                    </td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right font-semibold">
                      {formatBrl(w.pixAmountCents)}
                      <div className="text-xs font-normal text-muted">{formatMoney(w.amountCents)}</div>
                      {w.feeCents > 0 && <div className="text-xs font-normal text-muted">taxa {formatMoney(w.feeCents)}</div>}
                    </td>
                    <td className="px-4 py-2">
                      <div>{WITHDRAWAL_STATUS_LABEL[w.status]}</div>
                      <div className="text-xs text-muted">{w.speed === 'instant' ? 'Automático' : 'Normal'}</div>
                      {w.status === 'processing' && w.providerStatus === 'awaiting' && (
                        <div className="text-xs text-muted">Em análise no gateway (pode levar algumas horas)</div>
                      )}
                      {w.lastError && w.status === 'approved' && <div className="text-xs text-down">{w.lastError}</div>}
                      {w.note && <div className="text-xs text-muted">{w.note}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        {reviewable && (
                          <>
                            <Button variant="up" className="px-3 py-1" busy={busy === w.id} onClick={() => setConfirm(w)}>
                              {w.status === 'approved' ? 'Reenviar' : 'Aprovar'}
                            </Button>
                            <Button variant="secondary" className="px-3 py-1" disabled={busy === w.id} onClick={() => setRejecting(w)}>
                              Recusar
                            </Button>
                          </>
                        )}
                        {w.status === 'processing' && (
                          <Button variant="secondary" className="px-3 py-1" busy={busy === w.id} onClick={() => void act(w, 'refresh')}>
                            Atualizar status
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PagedFooter paged={list} />

      <Dialog open={confirm !== null} title="Aprovar saque" onClose={() => setConfirm(null)}>
        {confirm && (
          <>
            <p className="text-sm">
              Enviar <strong>{formatBrl(confirm.pixAmountCents)}</strong> ({formatMoney(confirm.amountCents - confirm.feeCents)}
              {confirm.feeCents > 0 ? ` de ${formatMoney(confirm.amountCents)}, taxa ${formatMoney(confirm.feeCents)}` : ''};{' '}
              {formatFxRate(confirm.fxRate)}) por Pix para a chave {PIX_KEY_LABEL[confirm.pixKeyType]}{' '}
              <strong className="break-all">{confirm.pixKey}</strong> ({confirm.userName})? O dinheiro sai do saldo da empresa no gateway e
              não dá para desfazer.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
              <Button variant="up" busy={busy === confirm.id} onClick={() => void act(confirm, 'approve')}>
                Enviar Pix
              </Button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog open={rejecting !== null} title="Recusar saque" onClose={() => setRejecting(null)}>
        {rejecting && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(rejecting, 'reject', note);
            }}
          >
            <p className="text-sm text-muted">
              {formatMoney(rejecting.amountCents)} volta para o saldo de {rejecting.userEmail}.
            </p>
            <Field label="Motivo (o cliente vê)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRejecting(null)}>
                Cancelar
              </Button>
              <Button type="submit" variant="down" busy={busy === rejecting.id} disabled={note.trim().length < 3}>
                Recusar e devolver
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
