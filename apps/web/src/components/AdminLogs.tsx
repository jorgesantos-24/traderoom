import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ACTIVITY_GROUPS, type ActivityGroup, type AdminActivityView } from '@traderoom/shared';
import { api } from '../lib/api';
import { DIRECTION_LABEL, formatDateTime, formatDuration, formatMoney, formatSignedMoney, LEDGER_LABEL, STATUS_LABEL } from '../lib/format';
import { usePaged } from '../lib/use-paged';
import { PagedFooter } from './PagedFooter';
import { Card, cx, EmptyState, ErrorState, LoadingState } from './ui';

const LIVE_MS = 4_000;
const FRESH_MS = 6_000;

const GROUP_LABEL: Record<ActivityGroup, string> = {
  trades: 'Operações',
  deposits: 'Depósitos',
  withdrawals: 'Saques',
  adjustments: 'Ajustes',
};
type Account = 'real' | 'demo' | 'all';
const ACCOUNT_OPTIONS: Array<[Account, string]> = [
  ['real', 'Real'],
  ['demo', 'Demo'],
  ['all', 'Todas'],
];

/** Icon tone and short title for each movement. */
function describe(e: AdminActivityView): { tone: 'up' | 'down' | 'brand' | 'warn' | 'muted'; icon: string; title: string } {
  const o = e.order;
  switch (e.kind) {
    case 'stake':
      return { tone: 'brand', icon: o?.direction === 'put' ? '▼' : '▲', title: o ? `Entrada em ${o.asset}` : 'Entrada em ordem' };
    case 'payout':
      return { tone: 'up', icon: '★', title: o ? `Ganhou em ${o.asset}` : 'Pagamento de ordem' };
    case 'refund':
      return { tone: 'muted', icon: '↺', title: o ? `Reembolso em ${o.asset}` : 'Reembolso' };
    case 'deposit':
      return { tone: 'up', icon: '↓', title: 'Depósito via Pix' };
    case 'deposit_reversal':
      return { tone: 'down', icon: '↑', title: 'Estorno de depósito' };
    case 'withdrawal':
      return { tone: 'warn', icon: '↑', title: 'Saque solicitado' };
    case 'withdrawal_return':
      return { tone: 'muted', icon: '↺', title: 'Saque devolvido' };
    default:
      return { tone: e.deltaCents >= 0 ? 'up' : 'down', icon: '±', title: LEDGER_LABEL[e.kind] ?? e.kind };
  }
}

const TONE: Record<ReturnType<typeof describe>['tone'], string> = {
  up: 'bg-up/15 text-up',
  down: 'bg-down/15 text-down',
  brand: 'bg-brand/15 text-brand',
  warn: 'bg-warn/15 text-warn',
  muted: 'bg-field text-muted',
};

const STATUS_TONE = { open: 'text-brand', won: 'text-up', lost: 'text-down', void: 'text-muted' } as const;

/** Every balance movement of every client, newest first, updating live. */
export function LogsTab() {
  const ids = useId();
  const [group, setGroup] = useState<ActivityGroup | ''>('');
  const [account, setAccount] = useState<Account>('real');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [live, setLive] = useState(true);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [lastSync, setLastSync] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const filters = { group: group || undefined, account, q: query || undefined };
  const filterKey = JSON.stringify(filters);
  const fetchPage = useCallback(
    (cursor?: string) => api.admin.activity({ ...(JSON.parse(filterKey) as typeof filters), cursor, limit: 50 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );
  const log = usePaged<AdminActivityView>(fetchPage, filterKey);
  const ready = log.status === 'ready';

  // Live: fetch the first page again and put what is new on top, highlighted for a few seconds.
  const prependRef = useRef(log.prepend);
  prependRef.current = log.prepend;
  useEffect(() => {
    if (!live || !ready) return;
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      fetchPage().then(
        (page) => {
          if (cancelled) return;
          setLastSync(Date.now());
          const seen = new Set(page.items.map((x) => x.id));
          const before = prependRef.current(page.items, (x) => x.id);
          if (before > 0) {
            const newIds = page.items.slice(0, before).map((x) => x.id).filter((id) => seen.has(id));
            setFresh((s) => new Set([...s, ...newIds]));
            setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !newIds.includes(id)))), FRESH_MS);
          }
        },
        () => {
          // A failed refresh keeps the list; the next tick tries again.
        },
      );
    };
    setLastSync(Date.now());
    const t = setInterval(tick, LIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [live, ready, fetchPage]);

  const chip = (on: boolean) =>
    cx(
      'shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
      on ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:border-[#3a4352] hover:text-text',
    );

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text">Movimentos dos clientes</h2>
            <p className="text-sm text-muted">Entradas, ganhos, depósitos, saques e ajustes, do mais recente para o mais antigo.</p>
          </div>
          <button
            type="button"
            aria-pressed={live}
            onClick={() => setLive((v) => !v)}
            className={cx(
              'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
              live ? 'border-up/50 bg-up/10 text-up' : 'border-border text-muted hover:text-text',
            )}
            title={live ? 'Pausar atualização automática' : 'Retomar atualização automática'}
          >
            <span className="relative flex size-2">
              {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-75" />}
              <span className={cx('relative inline-flex size-2 rounded-full', live ? 'bg-up' : 'bg-muted')} />
            </span>
            {live ? 'Ao vivo' : 'Pausado'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="scrollbar-none flex gap-1.5 overflow-x-auto" role="group" aria-label="Tipo de movimento">
            <button type="button" aria-pressed={group === ''} onClick={() => setGroup('')} className={chip(group === '')}>
              Tudo
            </button>
            {ACTIVITY_GROUPS.map((g) => (
              <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)} className={chip(group === g)}>
                {GROUP_LABEL[g]}
              </button>
            ))}
          </div>
          <div className="flex rounded-control border border-border bg-field p-0.5" role="radiogroup" aria-label="Conta">
            {ACCOUNT_OPTIONS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={account === k}
                onClick={() => setAccount(k)}
                className={cx(
                  'rounded px-2.5 py-1 text-xs font-semibold',
                  account === k ? 'bg-brand text-black' : 'text-muted hover:text-text',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <label htmlFor={`${ids}-q`} className="sr-only">
            Buscar cliente por nome ou e-mail
          </label>
          <input
            id={`${ids}-q`}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Buscar cliente (nome ou e-mail)"
            className="min-w-0 flex-1 basis-56 rounded-control border border-border bg-field px-3 py-1.5 text-sm text-text placeholder:text-muted focus:border-brand"
          />
        </div>
        {live && lastSync && ready && (
          <p className="text-xs text-muted" aria-live="off">
            Atualiza sozinho a cada {LIVE_MS / 1000} s
          </p>
        )}
      </div>

      {log.status === 'loading' && <LoadingState label="Carregando movimentos…" />}
      {log.status === 'error' && <ErrorState message={log.error ?? ''} onRetry={log.reload} />}
      {ready && log.items.length === 0 && (
        <EmptyState title="Nenhum movimento" hint={query || group ? 'Tente outro filtro.' : 'Os movimentos dos clientes aparecem aqui.'} />
      )}
      {ready && log.items.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Movimentos, mais recentes primeiro">
          {log.items.map((e) => (
            <ActivityRow key={e.id} e={e} fresh={fresh.has(e.id)} showAccount={account === 'all'} />
          ))}
        </ul>
      )}
      <PagedFooter paged={log} />
    </Card>
  );
}

function ActivityRow({ e, fresh, showAccount }: { e: AdminActivityView; fresh: boolean; showAccount: boolean }) {
  const d = describe(e);
  const o = e.order;
  return (
    <li
      className={cx('flex items-start gap-3 px-4 py-3 transition-colors duration-[1500ms]', fresh ? 'bg-brand/[0.07]' : 'bg-transparent')}
      data-testid="activity-row"
    >
      <span aria-hidden="true" className={cx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', TONE[d.tone])}>
        {d.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-text">{d.title}</span>
          {o && e.kind === 'stake' && (
            <span className="text-xs text-muted">
              <span className={o.direction === 'call' ? 'text-up' : 'text-down'}>{DIRECTION_LABEL[o.direction]}</span> ·{' '}
              {formatDuration(o.durationSec)} · payout {o.payoutPct}% ·{' '}
              <span className={cx('font-semibold', STATUS_TONE[o.status])}>{STATUS_LABEL[o.status]}</span>
            </span>
          )}
          {showAccount && (
            <span
              className={cx(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                e.account === 'real' ? 'bg-up/10 text-up' : 'bg-field text-muted',
              )}
            >
              {e.account}
            </span>
          )}
          {fresh && <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold text-brand uppercase">novo</span>}
        </div>
        <div className="truncate text-sm text-muted">
          <span className="text-[#c3c6ca]">{e.userName}</span> · {e.userEmail}
        </div>
        {e.note && e.kind !== 'stake' && e.kind !== 'payout' && <div className="mt-0.5 text-xs text-muted">{e.note}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={cx('tabular text-sm font-bold', e.deltaCents > 0 ? 'text-up' : e.deltaCents < 0 ? 'text-down' : 'text-muted')}>
          {formatSignedMoney(e.deltaCents)}
        </div>
        <div className="tabular text-xs text-muted">saldo {formatMoney(e.balanceAfterCents)}</div>
        <div className="tabular text-[11px] text-muted">{formatDateTime(e.createdAt)}</div>
      </div>
    </li>
  );
}
