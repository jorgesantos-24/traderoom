import { useEffect, useId, useState, type FormEvent } from 'react';
import { PREMIUM_INDICATOR_LABEL, PREMIUM_INDICATORS, type IndicatorAccessView, type PremiumIndicator } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, Field, FormMessage, LoadingState } from './ui';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; access: IndicatorAccessView[] };

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * Who may use the premium chart indicators (Smart Money Concepts, chart patterns). Nobody else sees
 * them in the indicator list; admins always do. A change reaches the user when the chart tab is
 * opened or comes back into view.
 */
export function IndicatorsTab({ onNotice }: { onNotice(m: string): void }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.admin.indicatorAccess().then(
      (access) => !cancelled && setState({ status: 'ready', access }),
      (err: unknown) => !cancelled && setState({ status: 'error', message: errMsg(err, 'Erro ao carregar os acessos.') }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const granted = (a: IndicatorAccessView) => {
    setState((s) =>
      s.status === 'ready'
        ? { status: 'ready', access: [a, ...s.access.filter((x) => !(x.userId === a.userId && x.indicator === a.indicator))] }
        : s,
    );
    onNotice(`${PREMIUM_INDICATOR_LABEL[a.indicator]} liberado para ${a.email}.`);
  };
  const revoked = (a: IndicatorAccessView) => {
    setState((s) =>
      s.status === 'ready' ? { status: 'ready', access: s.access.filter((x) => !(x.userId === a.userId && x.indicator === a.indicator)) } : s,
    );
    onNotice(`${PREMIUM_INDICATOR_LABEL[a.indicator]} retirado de ${a.email}.`);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="px-4 py-3 text-sm text-muted">
          Estes indicadores ficam escondidos no gráfico e só aparecem para os usuários liberados aqui (administradores sempre os veem). A
          mudança chega ao usuário quando ele abre o gráfico ou volta para a aba dele.
        </p>
      </Card>
      {state.status === 'loading' && (
        <Card>
          <LoadingState label="Carregando acessos…" />
        </Card>
      )}
      {state.status === 'error' && (
        <Card>
          <ErrorState
            message={state.message}
            onRetry={() => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          />
        </Card>
      )}
      {state.status === 'ready' &&
        PREMIUM_INDICATORS.map((ind) => (
          <IndicatorSection
            key={ind}
            indicator={ind}
            access={state.access.filter((a) => a.indicator === ind)}
            onGranted={granted}
            onRevoked={revoked}
          />
        ))}
    </div>
  );
}

function IndicatorSection({
  indicator,
  access,
  onGranted,
  onRevoked,
}: {
  indicator: PremiumIndicator;
  access: IndicatorAccessView[];
  onGranted(a: IndicatorAccessView): void;
  onRevoked(a: IndicatorAccessView): void;
}) {
  const ids = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) {
      setError('Informe o e-mail do usuário.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onGranted(await api.admin.grantIndicator(value, indicator));
      setEmail('');
    } catch (err) {
      setError(errMsg(err, 'Não foi possível liberar o acesso.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: IndicatorAccessView) => {
    setRemoving(a.userId);
    setError(null);
    try {
      await api.admin.revokeIndicator(a.userId, indicator);
      onRevoked(a);
    } catch (err) {
      setError(errMsg(err, 'Não foi possível retirar o acesso.'));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card aria-labelledby={`${ids}-title`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={`${ids}-title`} className="text-base font-semibold text-text">
          {PREMIUM_INDICATOR_LABEL[indicator]}
        </h2>
        <span className="text-sm text-muted">
          {access.length === 1 ? '1 usuário liberado' : `${access.length} usuários liberados`}
        </span>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border-b border-border p-4" noValidate>
        <Field
          label="E-mail do usuário"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-[16rem] flex-1"
          placeholder="cliente@exemplo.com"
        />
        <Button type="submit" busy={busy}>
          Liberar acesso
        </Button>
      </form>
      {error && (
        <div className="px-4 pt-3">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      )}
      {access.length === 0 ? (
        <EmptyState title="Ninguém liberado ainda" hint="Só os administradores veem este indicador." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Usuários com acesso a {PREMIUM_INDICATOR_LABEL[indicator]}</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Usuário
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Liberado em
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Por
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {access.map((a) => (
                <tr key={a.userId} className="border-t border-border" data-testid="indicator-access-row">
                  <td className="px-4 py-2">
                    <div className="font-medium text-text">{a.name}</div>
                    <div className="text-muted">{a.email}</div>
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(a.grantedAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{a.grantedByEmail ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="secondary" busy={removing === a.userId} onClick={() => void remove(a)}>
                      Retirar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
