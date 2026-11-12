import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AUDIT_ACTIONS,
  OTC_VOL_MAX,
  OTC_VOL_MIN,
  PAYOUT_PCT_MAX,
  PAYOUT_PCT_MIN,
  type AdminAssetView,
  type AdminUserView,
  type AuditAction,
} from '@traderoom/shared';
import { IndicatorsTab } from '../components/AdminIndicators';
import { KycTab } from '../components/AdminKyc';
import { OnlineTab } from '../components/AdminOnline';
import { WithdrawalsTab } from '../components/AdminWithdrawals';
import { AppShell } from '../components/AppShell';
import { Dialog } from '../components/Dialog';
import { PagedFooter } from '../components/PagedFooter';
import { Button, Card, cx, EmptyState, ErrorState, Field, FormMessage, LoadingState } from '../components/ui';
import { auditLabel, AUDIT_LABEL, describeAudit } from '../lib/admin';
import { api, ApiError, NETWORK_ERROR, newIdempotencyKey } from '../lib/api';
import { useUser } from '../lib/auth';
import { formatDateTime, formatMoney, parseMoneyToCents } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { useSessionData } from '../lib/session-data';
import { usePaged } from '../lib/use-paged';

const TABS = [
  { id: 'users', label: 'Usuários' },
  { id: 'online', label: 'Online' },
  { id: 'kyc', label: 'Verificações' },
  { id: 'withdrawals', label: 'Saques' },
  { id: 'assets', label: 'Ativos' },
  { id: 'indicators', label: 'Indicadores' },
  { id: 'audit', label: 'Auditoria' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function AdminPage() {
  const user = useUser();
  const { search } = useLocation();
  const raw = search.get('tab');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'users';
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const [notice, setNotice] = useState('');

  if (user.role !== 'admin') {
    return (
      <AppShell>
        <EmptyState title="Acesso restrito" hint="Esta área é só para administradores." className="h-96" />
      </AppShell>
    );
  }

  const select = (id: TabId, focus = false) => {
    navigate(id === 'users' ? '/admin' : `/admin?tab=${id}`, { replace: true });
    if (focus) tabRefs.current.get(id)?.focus();
  };

  // Tabs pattern: arrows move between tabs, Home/End jump to the ends.
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    select((TABS[next] as (typeof TABS)[number]).id, true);
  };

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Administração</h1>
        <Link href="/admin/otc-override" className="text-sm font-medium text-brand hover:underline">
          Intervenção no preço OTC →
        </Link>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="admin-notice">
        {notice}
      </div>
      <div
        role="tablist"
        aria-label="Seções do admin"
        className="scrollbar-none mb-4 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0] shadow-border"
        onKeyDown={onKey}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            className={cx(
              'shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'users' && <UsersTab selfId={user.id} onNotice={setNotice} />}
        {tab === 'online' && <OnlineTab />}
        {tab === 'kyc' && <KycTab onNotice={setNotice} />}
        {tab === 'withdrawals' && <WithdrawalsTab onNotice={setNotice} />}
        {tab === 'assets' && <AssetsTab onNotice={setNotice} />}
        {tab === 'indicators' && <IndicatorsTab onNotice={setNotice} />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </AppShell>
  );
}

// ---- Users ----

type UserAction = { kind: 'adjust'; user: AdminUserView } | { kind: 'block'; user: AdminUserView } | null;

function UsersTab({ selfId, onNotice }: { selfId: string; onNotice(m: string): void }) {
  const ids = useId();
  const { refreshWallet } = useSessionData();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<UserAction>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const fetchPage = useCallback((cursor?: string) => api.admin.users({ q: query || undefined, cursor, limit: 50 }), [query]);
  const users = usePaged<AdminUserView>(fetchPage, query);

  const updated = (u: AdminUserView, message: string) => {
    users.patch((x) => (x.id === u.id ? u : x));
    setAction(null);
    onNotice(message);
    if (u.id === selfId) void refreshWallet();
  };

  return (
    <Card>
      <div className="border-b border-border p-4">
        <label htmlFor={`${ids}-q`} className="mb-1.5 block text-sm font-medium">
          Buscar por nome ou e-mail
        </label>
        <input
          id={`${ids}-q`}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ex.: ana@exemplo.com"
          className="w-full max-w-md rounded-control border border-border bg-field px-3 py-2 text-sm text-text placeholder:text-muted focus:border-brand"
        />
      </div>
      {users.status === 'loading' && <LoadingState label="Carregando usuários…" />}
      {users.status === 'error' && <ErrorState message={users.error ?? ''} onRetry={users.reload} />}
      {users.status === 'ready' && users.items.length === 0 && (
        <EmptyState
          title={query ? 'Nenhum usuário encontrado' : 'Nenhum usuário cadastrado'}
          hint={query ? 'Tente outro nome ou e-mail.' : undefined}
        />
      )}
      {users.status === 'ready' && users.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Usuários, mais recentes primeiro</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Usuário
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Situação
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Saldo
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ordens abertas
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Cadastro
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {users.items.map((u) => (
                <tr key={u.id} className="border-t border-border" data-testid="admin-user-row">
                  <td className="px-4 py-2">
                    <div className="font-medium">
                      {u.name}
                      {u.role === 'admin' && <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs text-brand">admin</span>}
                    </div>
                    <div className="text-muted">{u.email}</div>
                  </td>
                  <td className={cx('whitespace-nowrap px-4 py-2 font-medium', u.status === 'blocked' ? 'text-down' : 'text-up')}>
                    {u.status === 'blocked' ? 'Bloqueado' : 'Ativo'}
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(u.balanceCents)}</td>
                  <td className="tabular px-4 py-2 text-right">{u.openOrders}</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(u.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5"
                        onClick={() => setAction({ kind: 'adjust', user: u })}
                        aria-label={`Ajustar saldo de ${u.name}`}
                      >
                        Ajustar saldo
                      </Button>
                      {u.id !== selfId && (
                        <Button
                          variant="secondary"
                          className="px-3 py-1.5"
                          onClick={() => setAction({ kind: 'block', user: u })}
                          aria-label={`${u.status === 'blocked' ? 'Desbloquear' : 'Bloquear'} ${u.name}`}
                        >
                          {u.status === 'blocked' ? 'Desbloquear' : 'Bloquear'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedFooter paged={users} />

      <Dialog open={action?.kind === 'adjust'} title="Ajustar saldo" onClose={() => setAction(null)}>
        {action?.kind === 'adjust' && (
          <AdjustForm
            user={action.user}
            onCancel={() => setAction(null)}
            onDone={(u, delta) =>
              updated(
                u,
                `${delta > 0 ? 'Crédito' : 'Débito'} de ${formatMoney(Math.abs(delta))} lançado para ${u.name}. Novo saldo: ${formatMoney(u.balanceCents)}.`,
              )
            }
          />
        )}
      </Dialog>
      <Dialog
        open={action?.kind === 'block'}
        title={action?.kind === 'block' && action.user.status === 'blocked' ? 'Desbloquear usuário' : 'Bloquear usuário'}
        onClose={() => setAction(null)}
      >
        {action?.kind === 'block' && (
          <BlockForm
            user={action.user}
            onCancel={() => setAction(null)}
            onDone={(u) => updated(u, `${u.name} foi ${u.status === 'blocked' ? 'bloqueado' : 'desbloqueado'}.`)}
          />
        )}
      </Dialog>
    </Card>
  );
}

function AdjustForm({ user, onCancel, onDone }: { user: AdminUserView; onCancel(): void; onDone(u: AdminUserView, delta: number): void }) {
  const ids = useId();
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; note?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per adjustment: retrying after a network failure cannot credit twice.
  const [key, setKey] = useState(newIdempotencyKey);

  const cents = parseMoneyToCents(amount);
  const delta = cents === null ? null : kind === 'credit' ? cents : -cents;
  const after = delta === null ? null : user.balanceCents + delta;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (delta === null) errs.amount = 'Informe um valor maior que zero, com até 2 casas decimais.';
    else if (after !== null && after < 0) errs.amount = `O débito máximo é ${formatMoney(user.balanceCents)}.`;
    if (note.trim().length < 3) errs.note = 'Descreva o motivo (mínimo 3 caracteres).';
    setErrors(errs);
    if (errs.amount || errs.note || delta === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.admin.adjust(user.id, delta, note.trim(), key);
      onDone(r.user, delta);
    } catch (err) {
      const network = err instanceof ApiError && err.code === NETWORK_ERROR;
      // Refused by the server: nothing was applied, so the next attempt is a new adjustment.
      if (!network) setKey(newIdempotencyKey());
      setError(
        network
          ? 'Sem resposta do servidor. Tente de novo: o ajuste não será lançado em dobro.'
          : errMsg(err, 'Não foi possível lançar o ajuste.'),
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {user.name} ({user.email}) · saldo atual <span className="tabular text-text">{formatMoney(user.balanceCents)}</span>
      </p>
      <fieldset className="flex gap-2">
        <legend className="mb-2 text-sm font-medium">Tipo</legend>
        {(['credit', 'debit'] as const).map((k) => (
          <label
            key={k}
            className={cx(
              'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-control border px-3 py-2 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand',
              kind === k ? 'border-brand bg-brand/10 text-brand' : 'border-border text-text',
            )}
          >
            <input type="radio" name={`${ids}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
            {k === 'credit' ? 'Crédito' : 'Débito'}
          </label>
        ))}
      </fieldset>
      <Field
        label="Valor (US$)"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
      />
      <Field
        label="Motivo"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        error={errors.note}
        hint="Fica registrado no extrato do usuário e na auditoria."
      />
      {after !== null && after >= 0 && (
        <p className="text-sm text-muted">
          Saldo após o ajuste: <span className="tabular font-semibold text-text">{formatMoney(after)}</span>
        </p>
      )}
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" busy={busy}>
          {kind === 'credit' ? 'Lançar crédito' : 'Lançar débito'}
        </Button>
      </div>
    </form>
  );
}

function BlockForm({ user, onCancel, onDone }: { user: AdminUserView; onCancel(): void; onDone(u: AdminUserView): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = user.status !== 'blocked';

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.admin.setBlocked(user.id, blocking));
    } catch (err) {
      setError(errMsg(err, 'Não foi possível alterar o bloqueio.'));
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-sm text-muted">
        {blocking
          ? `${user.name} (${user.email}) será desconectado na hora e não poderá entrar até ser desbloqueado. Ordens abertas continuam e serão liquidadas normalmente.`
          : `${user.name} (${user.email}) poderá entrar de novo.`}
      </p>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant={blocking ? 'down' : 'primary'} busy={busy} onClick={() => void confirm()}>
          {blocking ? 'Bloquear' : 'Desbloquear'}
        </Button>
      </div>
    </>
  );
}

// ---- Assets ----

function AssetsTab({ onNotice }: { onNotice(m: string): void }) {
  const { reloadCatalog } = useSessionData();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; assets: AdminAssetView[] }
  >({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.admin.assets().then(
      (assets) => !cancelled && setState({ status: 'ready', assets }),
      (err: unknown) => !cancelled && setState({ status: 'error', message: errMsg(err, 'Erro ao carregar os ativos.') }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const saved = (a: AdminAssetView) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', assets: s.assets.map((x) => (x.id === a.id ? a : x)) } : s));
    reloadCatalog();
    onNotice(`${a.display} salvo: payout ${a.payoutPct}%, ${a.enabled ? 'ativo' : 'desativado'}.`);
  };

  return (
    <Card>
      <p className="border-b border-border px-4 py-3 text-sm text-muted">
        O payout vale para ordens novas; ordens abertas mantêm o payout da abertura. Ativar ou desativar chega ao feed de preços em até 30
        s. Ativos OTC têm preço gerado pela plataforma; a volatilidade define o tamanho típico do movimento por hora (o sentido é sempre
        aleatório).
      </p>
      {state.status === 'loading' && <LoadingState label="Carregando ativos…" />}
      {state.status === 'error' && (
        <ErrorState
          message={state.message}
          onRetry={() => {
            setState({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {state.status === 'ready' && state.assets.length === 0 && <EmptyState title="Nenhum ativo cadastrado" />}
      {state.status === 'ready' && state.assets.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Ativos e payout</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Ativo
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Payout (%)
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Volatilidade (%/h)
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Disponível
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {state.assets.map((a) => (
                <AssetRow key={a.id} asset={a} onSaved={saved} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const volText = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));

function AssetRow({ asset, onSaved }: { asset: AdminAssetView; onSaved(a: AdminAssetView): void }) {
  const ids = useId();
  const [payout, setPayout] = useState(String(asset.payoutPct));
  const [enabled, setEnabled] = useState(asset.enabled);
  const [vol, setVol] = useState(volText(asset.otcVolPctHour));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPayout(String(asset.payoutPct));
    setEnabled(asset.enabled);
    setVol(volText(asset.otcVolPctHour));
  }, [asset]);

  const pct = /^\d{1,3}$/.test(payout.trim()) ? Number(payout.trim()) : null;
  const pctValid = pct !== null && pct >= PAYOUT_PCT_MIN && pct <= PAYOUT_PCT_MAX;
  const isOtc = asset.kind === 'otc';
  const volNum = isOtc && /^\d{1,2}([.,]\d{1,3})?$/.test(vol.trim()) ? Number(vol.trim().replace(',', '.')) : null;
  const volValid = !isOtc || (volNum !== null && volNum >= OTC_VOL_MIN && volNum <= OTC_VOL_MAX);
  const volChanged = isOtc && volNum !== asset.otcVolPctHour;
  const dirty = pct !== asset.payoutPct || enabled !== asset.enabled || volChanged;

  const save = async () => {
    if (!pctValid || !volValid || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const patch = {
        ...(pct !== asset.payoutPct ? { payoutPct: pct } : {}),
        ...(enabled !== asset.enabled ? { enabled } : {}),
        ...(volChanged && volNum !== null ? { otcVolPctHour: volNum } : {}),
      };
      onSaved(await api.admin.updateAsset(asset.id, patch));
    } catch (err) {
      setError(errMsg(err, 'Não foi possível salvar.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-t border-border align-top" data-testid="admin-asset-row">
      <td className="px-4 py-2">
        <div className="font-medium">
          {asset.display}
          {isOtc && (
            <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
              {asset.category === 'synthetic' ? 'Sintético' : asset.category === 'stocks' ? 'Ação OTC' : asset.category === 'forex' ? 'Forex OTC' : 'OTC'}
            </span>
          )}
          {asset.otcDriftPctHour !== 0 && (
            <div className="text-xs font-normal text-muted">
              Tendência {asset.otcDriftPctHour > 0 ? '+' : ''}
              {String(asset.otcDriftPctHour).replace('.', ',')}%/h · payout máx. 93%
            </div>
          )}
        </div>
        <div className="text-muted">{asset.symbol}</div>
      </td>
      <td className="px-4 py-2">
        <label htmlFor={`${ids}-pct`} className="sr-only">
          Payout de {asset.display} em porcentagem
        </label>
        <input
          id={`${ids}-pct`}
          inputMode="numeric"
          value={payout}
          onChange={(e) => setPayout(e.target.value)}
          aria-invalid={!pctValid || undefined}
          aria-describedby={!pctValid ? `${ids}-pct-err` : undefined}
          className={cx(
            'tabular w-20 rounded-control border bg-field px-2 py-1.5 text-sm',
            pctValid ? 'border-border focus:border-brand' : 'border-down',
          )}
        />
        {!pctValid && (
          <p id={`${ids}-pct-err`} className="mt-1 text-xs text-down">
            Entre {PAYOUT_PCT_MIN} e {PAYOUT_PCT_MAX}.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-down">
            {error}
          </p>
        )}
      </td>
      <td className="px-4 py-2">
        {isOtc ? (
          <>
            <label htmlFor={`${ids}-vol`} className="sr-only">
              Volatilidade de {asset.display} em porcentagem por hora
            </label>
            <input
              id={`${ids}-vol`}
              inputMode="decimal"
              value={vol}
              onChange={(e) => setVol(e.target.value)}
              aria-invalid={!volValid || undefined}
              className={cx(
                'tabular w-20 rounded-control border bg-field px-2 py-1.5 text-sm',
                volValid ? 'border-border focus:border-brand' : 'border-down',
              )}
            />
            {!volValid && (
              <p className="mt-1 text-xs text-down">
                Entre {volText(OTC_VOL_MIN)} e {OTC_VOL_MAX}.
              </p>
            )}
          </>
        ) : (
          <span className="text-muted">Mercado</span>
        )}
      </td>
      <td className="px-4 py-2">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[#00D8E8]" />
          <span>{enabled ? 'Sim' : 'Não'}</span>
          <span className="sr-only">— {asset.display} disponível para negociação</span>
        </label>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right">
        <div className="flex justify-end gap-2">
          {dirty && (
            <Button
              variant="ghost"
              className="px-3 py-1.5"
              onClick={() => {
                setPayout(String(asset.payoutPct));
                setEnabled(asset.enabled);
                setVol(volText(asset.otcVolPctHour));
                setError(null);
              }}
            >
              Descartar
            </Button>
          )}
          <Button
            className="px-3 py-1.5"
            disabled={!dirty || !pctValid || !volValid}
            busy={busy}
            onClick={() => void save()}
            aria-label={`Salvar ${asset.display}`}
          >
            Salvar
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ---- Audit ----

function AuditTab() {
  const ids = useId();
  const [action, setAction] = useState<AuditAction | ''>('');
  const fetchPage = useCallback((cursor?: string) => api.admin.audit({ action: action || undefined, cursor, limit: 50 }), [action]);
  const log = usePaged(fetchPage, action || 'all');

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
        <label htmlFor={`${ids}-action`} className="text-sm text-muted">
          Ação
        </label>
        <select
          id={`${ids}-action`}
          value={action}
          onChange={(e) => setAction(e.target.value as AuditAction | '')}
          className="rounded-control border border-border bg-field px-3 py-1.5 text-sm text-text"
        >
          <option value="">Todas</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {AUDIT_LABEL[a]}
            </option>
          ))}
        </select>
      </div>
      {log.status === 'loading' && <LoadingState label="Carregando auditoria…" />}
      {log.status === 'error' && <ErrorState message={log.error ?? ''} onRetry={log.reload} />}
      {log.status === 'ready' && log.items.length === 0 && (
        <EmptyState title="Nenhum registro" hint="As ações dos administradores aparecem aqui." />
      )}
      {log.status === 'ready' && log.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Log de auditoria, mais recentes primeiro</caption>
            <thead className="text-left text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Data
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Administrador
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Ação
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Detalhes
                </th>
              </tr>
            </thead>
            <tbody>
              {log.items.map((e) => (
                <tr key={e.id} className="border-t border-border" data-testid="audit-row">
                  <td className="tabular whitespace-nowrap px-4 py-2 text-muted">{formatDateTime(e.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2">{e.adminEmail}</td>
                  <td className="whitespace-nowrap px-4 py-2 font-medium">{auditLabel(e.action)}</td>
                  <td className="px-4 py-2 text-muted">{describeAudit(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedFooter paged={log} />
    </Card>
  );
}
