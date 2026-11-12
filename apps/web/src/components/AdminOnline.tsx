import { useEffect, useState } from 'react';
import type { AdminOnlineResponse } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatMoney, formatTime } from '../lib/format';
import { Card, EmptyState, ErrorState, LoadingState } from './ui';

const REFRESH_MS = 10_000;

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AdminOnlineResponse };

/** "há 3 min", "há 1 h 20 min". */
function onlineFor(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `há ${h} h ${rest} min` : `há ${h} h`;
}

/** Users with the trading screen open right now (a live connection to the price server). Refreshes every 10 s. */
export function OnlineTab() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.admin.online().then(
        (data) => {
          if (cancelled) return;
          setNow(Date.now());
          setState({ status: 'ready', data });
        },
        (err: unknown) => {
          if (cancelled) return;
          // Keep the last list on a failed refresh; only an empty screen shows the error.
          setState((s) =>
            s.status === 'ready' ? s : { status: 'error', message: err instanceof ApiError ? err.message : 'Erro ao carregar quem está online.' },
          );
        },
      );
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [attempt]);

  if (state.status === 'loading') {
    return (
      <Card>
        <LoadingState label="Carregando quem está online…" />
      </Card>
    );
  }
  if (state.status === 'error') {
    return (
      <Card>
        <ErrorState
          message={state.message}
          onRetry={() => {
            setState({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      </Card>
    );
  }

  const { users, updatedAt } = state.data;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-text">
          {users.length === 1 ? '1 usuário online' : `${users.length} usuários online`}
        </h2>
        <span className="text-sm text-muted">
          {updatedAt ? `Atualizado às ${formatTime(updatedAt)} · atualiza sozinho a cada 10 s` : 'Servidor de preços sem resposta'}
        </span>
      </div>
      {users.length === 0 ? (
        <EmptyState
          title={updatedAt ? 'Ninguém online agora' : 'Lista indisponível'}
          hint={
            updatedAt
              ? 'Aparece aqui quem estiver com a tela de operação aberta.'
              : 'O servidor de preços não publicou a lista. Ele pode estar reiniciando; tente de novo em alguns segundos.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Usuários online agora</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Usuário
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Online desde
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Ativos abertos
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Abas
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Saldo real
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border" data-testid="online-user-row">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 font-medium text-text">
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-up" />
                      {u.name}
                      {u.role === 'admin' && <span className="text-xs font-normal text-muted">(admin)</span>}
                    </div>
                    <div className="pl-4 text-muted">{u.email}</div>
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-muted">
                    {formatTime(u.onlineSince)} <span className="text-xs">({onlineFor(u.onlineSince, now)})</span>
                  </td>
                  <td className="px-4 py-2 text-muted">{u.assets.length ? u.assets.join(', ') : '—'}</td>
                  <td className="tabular px-4 py-2 text-right text-muted">{u.connections}</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(u.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
