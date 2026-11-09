import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountKind, OrderStats, OrderView, StatsResult } from '@traderoom/shared';
import { AppShell } from '../components/AppShell';
import { CoinIcon } from '../components/CoinIcon';
import { PagedFooter } from '../components/PagedFooter';
import { Card, cx, EmptyState, ErrorState, LoadingState } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatMoney, formatShortDate, formatSignedMoney, formatTime } from '../lib/format';
import { useHideBalances } from '../lib/hide-balance';
import { netCents } from '../lib/orders';
import { useSessionData } from '../lib/session-data';
import { usePaged } from '../lib/use-paged';

type Period = 'day' | 'week' | 'month' | 'custom';

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'day', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
  { id: 'custom', label: 'Personalizado' },
];

const RESULTS: Array<{ id: StatsResult; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'won', label: 'Ganhou' },
  { id: 'lost', label: 'Perdeu' },
  { id: 'void', label: 'Empatou' },
];

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** "YYYY-MM-DD" of a local date. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDay(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function today(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local-midnight range [from, to) for a preset, or for the custom first/last day (both included). */
function rangeOf(period: Period, first: string, last: string): { from: Date; to: Date } | null {
  const t = today();
  if (period === 'day') return { from: t, to: addDays(t, 1) };
  if (period === 'week') return { from: addDays(t, -6), to: addDays(t, 1) };
  if (period === 'month') return { from: addDays(t, -29), to: addDays(t, 1) };
  const a = parseDay(first);
  const b = parseDay(last);
  if (!a || !b || b < a) return null;
  return { from: a, to: addDays(b, 1) };
}

const dayLabel = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

/**
 * "Análises de operações": what the client traded in a period, with the same figures
 * as XGlobal (totals, profit, best and worst order, hit rate, stake range, daily P/L).
 */
export function AnalyticsPage() {
  const session = useSessionData();
  const hide = useHideBalances();
  const [account, setAccount] = useState<AccountKind>(session.account);
  const [period, setPeriod] = useState<Period>('week');
  const [result, setResult] = useState<StatsResult>('all');
  const [first, setFirst] = useState(() => dayKey(addDays(today(), -6)));
  const [last, setLast] = useState(() => dayKey(today()));

  const range = rangeOf(period, first, last);
  const from = range?.from.toISOString() ?? '';
  const to = range?.to.toISOString() ?? '';
  const tooLong = range !== null && range.to.getTime() - range.from.getTime() > 370 * 86_400_000;
  const valid = range !== null && !tooLong;
  const query = `${account}|${result}|${from}|${to}`;

  const [stats, setStats] = useState<{ key: string; data: OrderStats } | { key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    api.orderStats({ account, result, from, to, tz: TZ }).then(
      (data) => live && setStats({ key: query, data }),
      (err: unknown) =>
        live && setStats({ key: query, error: err instanceof ApiError ? err.message : 'Não foi possível carregar as análises.' }),
    );
    return () => {
      live = false;
    };
  }, [account, result, from, to, query, valid, attempt]);

  const fetchPage = useCallback(
    (cursor?: string) => api.orderHistory({ account, result, from, to, cursor, limit: 20 }),
    [account, result, from, to],
  );
  const history = usePaged<OrderView>(fetchPage, valid ? query : 'invalid');

  const balances = session.accounts.status === 'ready' ? session.accounts.data : [];
  const balanceOf = (k: AccountKind) => balances.find((a) => a.account === k)?.balanceCents;
  const current = stats && stats.key === query ? stats : null;
  const name = useAssetName();

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Análises de operações</h1>
          <p className="mt-1 text-sm text-muted">Seus resultados no período escolhido. Operações em andamento entram quando encerram.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-2" role="radiogroup" aria-label="Conta analisada">
            {(['real', 'demo'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={account === k}
                onClick={() => setAccount(k)}
                className={cx(
                  'min-w-32 rounded-control border px-3 py-2 text-left transition-colors',
                  account === k
                    ? k === 'real'
                      ? 'border-up/50 bg-up/10'
                      : 'border-warn/50 bg-warn/10'
                    : 'border-border bg-field hover:border-muted',
                )}
              >
                <span className="block text-[11px] font-semibold tracking-wide text-muted uppercase">
                  {k === 'real' ? 'Conta real' : 'Conta demo'}
                </span>
                <span className={cx('tabular block text-sm font-bold', k === 'real' ? 'text-up' : 'text-warn')}>
                  {balanceOf(k) === undefined ? '—' : hide.money(balanceOf(k)!)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 p-3">
        <span className="px-1 text-sm font-semibold">Filtros</span>
        <Segmented<Period> label="Período" options={PERIODS} value={period} onChange={setPeriod} />
        <label className="flex items-center gap-2 text-sm text-muted">
          Tipo
          <select
            value={result}
            onChange={(e) => setResult(e.target.value as StatsResult)}
            className="rounded-control border border-border bg-field px-2.5 py-1.5 text-sm text-text focus:border-brand focus:outline-none"
          >
            {RESULTS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <DateInput label="De" value={first} max={last} onChange={setFirst} />
            <DateInput label="Até" value={last} min={first} max={dayKey(today())} onChange={setLast} />
          </div>
        )}
        {range && (
          <span className="ml-auto text-xs text-muted">
            {dayLabel.format(range.from)} – {dayLabel.format(addDays(range.to, -1))}
          </span>
        )}
      </Card>

      {!valid && (
        <Card className="mb-4">
          <ErrorState message={tooLong ? 'Escolha um período de até 370 dias.' : 'Escolha uma data inicial antes da final.'} />
        </Card>
      )}
      {valid && !current && (
        <Card className="mb-4">
          <LoadingState label="Calculando…" />
        </Card>
      )}
      {valid && current && 'error' in current && (
        <Card className="mb-4">
          <ErrorState message={current.error} onRetry={() => setAttempt((n) => n + 1)} />
        </Card>
      )}
      {valid && current && 'data' in current && range && <StatsView s={current.data} from={range.from} to={range.to} />}

      {valid && (
        <Card aria-labelledby="ops-title" className="overflow-hidden">
          <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
            <h2 id="ops-title" className="text-base font-semibold">
              Operações do período
            </h2>
            {history.status === 'ready' && <span className="text-xs text-muted">{history.items.length} carregadas</span>}
          </div>
          {history.status === 'loading' && <LoadingState label="Carregando operações…" />}
          {history.status === 'error' && <ErrorState message={history.error ?? ''} onRetry={history.reload} />}
          {history.status === 'ready' && history.items.length === 0 && (
            <EmptyState title="Nenhuma operação encontrada" hint="Mude o período ou o tipo para ver outras operações." />
          )}
          {history.status === 'ready' && history.items.length > 0 && (
            // Phones: one compact row per operation, every figure visible without side scrolling.
            <ul className="sm:hidden">
              {history.items.map((o) => {
                const net = netCents(o);
                return (
                  <li key={o.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
                    <CoinIcon symbol={o.symbol} className="size-7 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {name(o.symbol)}
                        <span className={cx('text-xs font-semibold', o.direction === 'call' ? 'text-up' : 'text-down')}>
                          {o.direction === 'call' ? '▲' : '▼'}
                        </span>
                      </p>
                      <p className="tabular text-xs text-muted">
                        {formatShortDate(o.opensAt)} · {formatTime(o.opensAt).slice(0, 5)} → {formatTime(o.expiresAt).slice(0, 5)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={cx(
                          'tabular text-sm font-semibold',
                          o.status === 'won' ? 'text-up' : o.status === 'lost' ? 'text-down' : 'text-muted',
                        )}
                      >
                        {o.status === 'void' ? 'Empate' : formatSignedMoney(net)}
                      </p>
                      <p className="tabular text-xs text-muted">
                        {formatMoney(o.stakeCents)} · {o.payoutPct}%
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {history.status === 'ready' && history.items.length > 0 && (
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2.5 font-medium">Ativo</th>
                    <th className="px-4 py-2.5 font-medium">Abertura (fechamento)</th>
                    <th className="px-4 py-2.5 text-right font-medium">Valor operado</th>
                    <th className="px-4 py-2.5 text-right font-medium">Payout</th>
                    <th className="px-4 py-2.5 text-right font-medium">L/P</th>
                  </tr>
                </thead>
                <tbody>
                  {history.items.map((o) => {
                    const net = netCents(o);
                    return (
                      <tr key={o.id} className="border-b border-border/60 last:border-b-0 hover:bg-field/50" data-testid="analytics-row">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2.5">
                            <CoinIcon symbol={o.symbol} className="size-5" />
                            <span className="font-medium">{name(o.symbol)}</span>
                            <span className={cx('text-xs font-semibold', o.direction === 'call' ? 'text-up' : 'text-down')}>
                              {o.direction === 'call' ? '▲ Compra' : '▼ Venda'}
                            </span>
                          </span>
                        </td>
                        <td className="tabular px-4 py-2.5 whitespace-nowrap text-muted">
                          <span className="text-text">{formatTime(o.opensAt)}</span> ({formatTime(o.expiresAt)}) ·{' '}
                          {formatShortDate(o.opensAt)}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">{formatMoney(o.stakeCents)}</td>
                        <td className="tabular px-4 py-2.5 text-right text-muted">{o.payoutPct}%</td>
                        <td
                          className={cx(
                            'tabular px-4 py-2.5 text-right font-semibold',
                            o.status === 'won' ? 'text-up' : o.status === 'lost' ? 'text-down' : 'text-muted',
                          )}
                        >
                          {o.status === 'void' ? 'Empate' : formatSignedMoney(net)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <PagedFooter paged={history} />
        </Card>
      )}
    </AppShell>
  );
}

function useAssetName() {
  const { catalog } = useSessionData();
  const display = useMemo(
    () => new Map(catalog.status === 'ready' ? catalog.data.assets.map((a) => [a.symbol, a.display]) : []),
    [catalog],
  );
  return (s: string) => display.get(s) ?? s;
}

function StatsView({ s, from, to }: { s: OrderStats; from: Date; to: Date }) {
  const money = formatMoney;
  const decided = s.won + s.lost;
  const signed = (c: number | null) => (c === null ? '—' : formatSignedMoney(c));
  const tone = (c: number | null) => (c === null || c === 0 ? 'text-text' : c > 0 ? 'text-up' : 'text-down');
  const bestDay = s.daily.length ? Math.max(...s.daily.map((d) => d.netCents)) : null;
  const worstDay = s.daily.length ? Math.min(...s.daily.map((d) => d.netCents)) : null;

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm font-medium text-muted">Total de operações</p>
          <p className="tabular mt-1 text-3xl font-bold" data-testid="stats-total">
            {s.total}
          </p>
          <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-field" aria-hidden="true">
            {decided > 0 && (
              <>
                <span className="rounded-full bg-up" style={{ width: `${(s.won / decided) * 100}%` }} />
                <span className="rounded-full bg-down" style={{ width: `${(s.lost / decided) * 100}%` }} />
              </>
            )}
          </div>
          <dl className="mt-3 space-y-1 text-sm">
            <Legend dot="bg-up" label="Ganhas" value={s.won} />
            <Legend dot="bg-down" label="Perdidas" value={s.lost} />
            <Legend dot="bg-muted" label="Empates" value={s.void} />
          </dl>
        </Card>

        <Card className="relative overflow-hidden p-5">
          <Glow positive={s.profitCents >= 0} />
          <p className="relative text-sm font-medium text-muted">Lucro total</p>
          <p className={cx('tabular relative mt-1 text-3xl font-bold', tone(s.profitCents))} data-testid="stats-profit">
            {signed(s.profitCents)}
          </p>
          <p className="relative mt-3 text-xs text-muted">
            Volume operado <span className="tabular font-semibold text-text">{money(s.volumeCents)}</span>
          </p>
        </Card>

        <Card className="flex flex-col justify-center gap-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted">Maior lucro</span>
            <span className={cx('tabular text-lg font-bold', tone(s.bestCents))}>{signed(s.bestCents)}</span>
          </div>
          <div className="h-px bg-border" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted">Menor lucro</span>
            <span className={cx('tabular text-lg font-bold', tone(s.worstCents))}>{signed(s.worstCents)}</span>
          </div>
        </Card>

        <Card className="flex items-center gap-4 p-5">
          <Ring pct={s.winRatePct} />
          <div>
            <p className="text-sm font-medium">Taxa de acerto</p>
            <p className="mt-1 text-xs text-muted">
              {decided === 0 ? 'Sem operações decididas no período.' : `${s.won} de ${decided} operações decididas.`}
            </p>
          </div>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <MinMax label="Valor máximo operado" value={s.maxStakeCents === null ? '—' : money(s.maxStakeCents)} up />
        <MinMax label="Valor mínimo operado" value={s.minStakeCents === null ? '—' : money(s.minStakeCents)} />
      </div>

      <Card className="mb-4 p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Lucro por dia</h2>
            <p className="text-xs text-muted">Resultado de cada dia do período. Toque ou passe o mouse numa barra para ver os detalhes.</p>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
            <Mini
              label="Acumulado"
              value={signed(s.daily.at(-1)?.cumulativeCents ?? (s.total ? 0 : null))}
              tone={tone(s.daily.at(-1)?.cumulativeCents ?? null)}
            />
            <Mini label="Melhor dia" value={signed(bestDay)} tone={tone(bestDay)} />
            <Mini label="Pior dia" value={signed(worstDay)} tone={tone(worstDay)} />
          </div>
        </div>
        {s.daily.length === 0 ? (
          <EmptyState title="Nenhum resultado no período" hint="Quando suas operações encerrarem, o lucro de cada dia aparece aqui." />
        ) : (
          <DailyChart s={s} from={from} to={to} money={money} signed={signed} />
        )}
      </Card>
    </>
  );
}

/** Daily net as bars around a zero line: green above, red below. */
function DailyChart({
  s,
  from,
  to,
  money,
  signed,
}: {
  s: OrderStats;
  from: Date;
  to: Date;
  money(c: number): string;
  signed(c: number | null): string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const byDay = new Map(s.daily.map((d) => [d.day, d]));
    const out: Array<{ day: Date; net: number; orders: number; cumulative: number }> = [];
    let cumulative = 0;
    for (let d = from; d < to; d = addDays(d, 1)) {
      const hit = byDay.get(dayKey(d));
      if (hit) cumulative = hit.cumulativeCents;
      out.push({ day: d, net: hit?.netCents ?? 0, orders: hit?.orders ?? 0, cumulative });
    }
    return out;
  }, [s, from, to]);
  const top = Math.max(0, ...days.map((d) => d.net));
  const bottom = Math.min(0, ...days.map((d) => d.net));
  const span = top - bottom || 1;
  const zero = (top / span) * 100;
  const h = hover === null ? null : days[hover];

  return (
    <div className="relative">
      <div className="flex gap-3">
        <div className="tabular flex w-20 shrink-0 flex-col justify-between py-0.5 text-right text-[11px] text-muted" aria-hidden="true">
          <span>{top > 0 ? money(top) : ''}</span>
          <span>{bottom < 0 ? money(bottom) : ''}</span>
        </div>
        <div className="relative h-48 flex-1" onMouseLeave={() => setHover(null)}>
          <div className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${zero}%` }} />
          <div className="absolute inset-0 flex gap-[2px]">
            {days.map((d, i) => {
              const size = (Math.abs(d.net) / span) * 100;
              return (
                <div key={i} className="relative h-full flex-1" onMouseEnter={() => setHover(i)}>
                  {hover === i && <div className="absolute inset-0 rounded bg-field/70" />}
                  {d.net !== 0 && (
                    <div
                      className={cx('absolute inset-x-[15%] max-w-8 mx-auto', d.net > 0 ? 'rounded-t bg-up' : 'rounded-b bg-down')}
                      style={d.net > 0 ? { bottom: `${100 - zero}%`, height: `${size}%` } : { top: `${zero}%`, height: `${size}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {h && hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute -top-2 z-10 w-44 -translate-y-full rounded-control border border-border bg-bg/95 px-3 py-2 text-xs shadow-xl"
              style={{ left: `clamp(0px, calc(${((hover + 0.5) / days.length) * 100}% - 88px), calc(100% - 176px))` }}
            >
              <p className="font-semibold">{dayLabel.format(h.day)}</p>
              <p className="mt-1 flex justify-between gap-2">
                <span className="text-muted">Resultado</span>
                <span className="tabular font-semibold">{signed(h.net)}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span className="text-muted">Acumulado</span>
                <span className="tabular">{signed(h.cumulative)}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span className="text-muted">Operações</span>
                <span className="tabular">{h.orders}</span>
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-23 text-[11px] text-muted" aria-hidden="true">
        <span>{dayLabel.format(from)}</span>
        {days.length > 1 && <span>{dayLabel.format(addDays(to, -1))}</span>}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange(v: T): void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-control border border-border bg-field p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'rounded-[8px] px-3 py-1.5 text-sm font-medium transition-colors',
            value === o.id ? 'brand-gradient text-bg' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange(v: string): void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      {label}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-control border border-border bg-field px-2 py-1.5 text-sm text-text [color-scheme:dark] focus:border-brand focus:outline-none"
      />
    </label>
  );
}

function Legend({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-muted">
        <span className={cx('size-2 rounded-full', dot)} />
        {label}
      </dt>
      <dd className="tabular font-semibold">{value}</dd>
    </div>
  );
}

function Glow({ positive }: { positive: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'pointer-events-none absolute -top-20 -right-16 size-52 rounded-full',
        positive
          ? 'bg-[radial-gradient(circle,rgb(34_197_94/0.18),transparent_65%)]'
          : 'bg-[radial-gradient(circle,rgb(240_79_74/0.18),transparent_65%)]',
      )}
    />
  );
}

function Ring({ pct }: { pct: number | null }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const v = pct ?? 0;
  return (
    <div className="relative size-20 shrink-0">
      <svg viewBox="0 0 72 72" className="size-20 -rotate-90" aria-hidden="true">
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="7" className="stroke-field" />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          className="stroke-brand transition-[stroke-dasharray] duration-500"
          strokeDasharray={`${(v / 100) * c} ${c}`}
        />
      </svg>
      <span className="tabular absolute inset-0 flex items-center justify-center text-lg font-bold" data-testid="stats-winrate">
        {pct === null ? '—' : `${String(Math.round(v)).replace('.', ',')}%`}
      </span>
    </div>
  );
}

function MinMax({ label, value, up = false }: { label: string; value: string; up?: boolean }) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className={cx('flex size-10 items-center justify-center rounded-full', up ? 'bg-brand/10 text-brand' : 'bg-field text-muted')}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {up ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}
        </svg>
      </span>
      <div>
        <p className="text-sm text-muted">{label}</p>
        <p className="tabular text-xl font-bold">{value}</p>
      </div>
    </Card>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: string }): ReactNode {
  return (
    <div className="min-w-0 rounded-control border border-border bg-field px-2.5 py-2 sm:px-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={cx('tabular truncate text-xs font-bold sm:text-sm', tone)}>{value}</p>
    </div>
  );
}
