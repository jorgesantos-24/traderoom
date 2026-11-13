import { useEffect, useState } from 'react';
import type { AdminResultsResponse, HouseClientResult, HouseDay, HousePeriodResult } from '@traderoom/shared';
import { api, ApiError } from '../lib/api';
import { formatMoney, formatSignedMoney, formatTime, TIME_ZONE } from '../lib/format';
import { Card, cx, ErrorState, LoadingState } from './ui';

const REFRESH_MS = 30_000;

type PeriodKey = 'today' | 'week' | 'month';
const PERIODS: Array<{ id: PeriodKey; label: string; long: string }> = [
  { id: 'today', label: 'Hoje', long: 'de hoje' },
  { id: 'week', label: 'Semana', long: 'desta semana' },
  { id: 'month', label: 'Mês', long: 'deste mês' },
];

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AdminResultsResponse };

const tone = (c: number) => (c > 0 ? 'text-up' : c < 0 ? 'text-down' : 'text-muted');
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const dayLabel = (key: string) => dayFmt.format(new Date(`${key}T12:00:00Z`));

/**
 * What the house made or lost against its clients: real money only, admins left out.
 * The house keeps the stake of every losing order and pays the profit of every winning one,
 * so when clients win a lot the result goes negative.
 */
export function ResultsTab() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [period, setPeriod] = useState<PeriodKey>('today');

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.admin.results(TIME_ZONE).then(
        (data) => {
          if (!cancelled) setState({ status: 'ready', data });
        },
        (err: unknown) => {
          if (cancelled) return;
          setState((s) =>
            s.status === 'ready' ? s : { status: 'error', message: err instanceof ApiError ? err.message : 'Erro ao carregar os resultados.' },
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
        <LoadingState label="Calculando resultados…" />
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

  const d = state.data;
  const p = d[period];
  const meta = PERIODS.find((x) => x.id === period)!;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Resultado da casa</h2>
          <p className="text-sm text-muted">
            Só conta real, sem administradores. Atualizado às {formatTime(d.generatedAt)} · horário de Brasília.
          </p>
        </div>
        <div className="flex rounded-control border border-border bg-field p-0.5" role="radiogroup" aria-label="Período">
          {PERIODS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={period === x.id}
              onClick={() => setPeriod(x.id)}
              className={cx('rounded px-3 py-1 text-sm font-semibold', period === x.id ? 'bg-brand text-black' : 'text-muted hover:text-text')}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <Hero p={p} label={meta.long} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Entradas" value={p.entries.toLocaleString('pt-BR')} hint={`${p.traders} ${p.traders === 1 ? 'cliente' : 'clientes'}`} />
        <Stat label="Volume apostado" value={formatMoney(p.volumeCents)} hint={p.entries ? `média ${formatMoney(Math.round(p.volumeCents / p.entries))}` : undefined} />
        <Stat
          label="Clientes ganharam"
          value={`${p.won} de ${p.won + p.lost}`}
          hint={`${pct(p.won, p.won + p.lost)} de acerto${p.open ? ` · ${p.open} em aberto` : ''}`}
          valueClass={p.won > p.lost ? 'text-down' : undefined}
        />
        <Stat label="Margem sobre o volume" value={pct(p.houseCents, p.volumeCents)} valueClass={tone(p.houseCents)} hint="resultado ÷ volume" />
        <Stat label="Depósitos" value={formatMoney(p.depositsCents)} hint={`${p.depositsCount} pagos`} valueClass="text-up" />
        <Stat label="Saques" value={formatMoney(p.withdrawalsCents)} hint={`${p.withdrawalsCount} concluídos`} valueClass="text-warn" />
        <Stat
          label="Fluxo de caixa"
          value={formatSignedMoney(p.depositsCents - p.withdrawalsCents)}
          hint="depósitos − saques"
          valueClass={tone(p.depositsCents - p.withdrawalsCents)}
        />
        <Stat
          label="Em aberto agora"
          value={`${d.openNow.orders} ${d.openNow.orders === 1 ? 'ordem' : 'ordens'}`}
          hint={d.openNow.orders ? `se todas ganharem: −${formatMoney(d.openNow.maxPayoutCents)}` : 'nenhum risco agora'}
          valueClass={d.openNow.orders ? 'text-brand' : undefined}
        />
      </div>

      <Compare d={d} active={period} onPick={setPeriod} />

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-text">Últimos 30 dias</h3>
          <span className="text-xs text-muted">
            <span className="text-up">▮</span> casa ganhou · <span className="text-down">▮</span> clientes ganharam
          </span>
        </div>
        <DailyBars days={d.daily} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <ClientList
          title="Clientes que mais ganharam (mês)"
          hint="A casa perdeu para eles."
          rows={d.topWinners}
          empty="Nenhum cliente no lucro este mês."
        />
        <ClientList
          title="Clientes que mais perderam (mês)"
          hint="A casa ganhou deles."
          rows={d.topLosers}
          empty="Nenhum cliente no prejuízo este mês."
        />
      </div>
    </div>
  );
}

function Hero({ p, label }: { p: HousePeriodResult; label: string }) {
  const up = p.houseCents >= 0;
  const total = p.collectedCents + p.paidCents;
  const share = total > 0 ? (p.collectedCents / total) * 100 : 50;
  return (
    <Card className={cx('overflow-hidden p-5', p.houseCents > 0 ? 'border-up/40' : p.houseCents < 0 ? 'border-down/40' : '')}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Lucro da casa {label}</p>
          <p className={cx('tabular text-4xl font-bold tracking-tight', tone(p.houseCents))} data-testid="house-result">
            {formatSignedMoney(p.houseCents)}
          </p>
          <p className={cx('mt-1 text-sm font-semibold', tone(p.houseCents))}>
            {p.houseCents === 0 ? 'Empatado' : up ? 'Casa no positivo' : 'Casa no negativo — clientes estão ganhando'}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">Perdas dos clientes</dt>
          <dd className="tabular text-right font-semibold text-up">+{formatMoney(p.collectedCents)}</dd>
          <dt className="text-muted">Lucro pago aos clientes</dt>
          <dd className="tabular text-right font-semibold text-down">−{formatMoney(p.paidCents)}</dd>
        </dl>
      </div>
      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-field" aria-hidden="true">
        {total > 0 && (
          <>
            <div className="bg-up" style={{ width: `${share}%` }} />
            <div className="bg-down" style={{ width: `${100 - share}%` }} />
          </>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cx('tabular mt-1 truncate text-xl font-bold text-text', valueClass)}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function Compare({ d, active, onPick }: { d: AdminResultsResponse; active: PeriodKey; onPick(p: PeriodKey): void }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Período</th>
            <th className="px-4 py-2 text-right font-medium">Entradas</th>
            <th className="px-4 py-2 text-right font-medium">Volume</th>
            <th className="px-4 py-2 text-right font-medium">Ganhas / perdidas</th>
            <th className="px-4 py-2 text-right font-medium">Depósitos</th>
            <th className="px-4 py-2 text-right font-medium">Saques</th>
            <th className="px-4 py-2 text-right font-medium">Lucro da casa</th>
          </tr>
        </thead>
        <tbody>
          {PERIODS.map((x) => {
            const p = d[x.id];
            return (
              <tr
                key={x.id}
                onClick={() => onPick(x.id)}
                className={cx('cursor-pointer border-b border-border last:border-0 hover:bg-field/60', active === x.id && 'bg-brand/[0.06]')}
              >
                <td className="px-4 py-2 font-semibold text-text">{x.label}</td>
                <td className="tabular px-4 py-2 text-right">{p.entries}</td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(p.volumeCents)}</td>
                <td className="tabular px-4 py-2 text-right">
                  <span className="text-up">{p.won}</span> / <span className="text-down">{p.lost}</span>
                </td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(p.depositsCents)}</td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatMoney(p.withdrawalsCents)}</td>
                <td className={cx('tabular whitespace-nowrap px-4 py-2 text-right font-bold', tone(p.houseCents))}>{formatSignedMoney(p.houseCents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** House result per day as bars around a zero line. */
function DailyBars({ days }: { days: HouseDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(0, ...days.map((x) => x.houseCents));
  const bottom = Math.min(0, ...days.map((x) => x.houseCents));
  const span = top - bottom || 1;
  const zero = (top / span) * 100;
  const h = hover === null ? null : days[hover];
  const total = days.reduce((s, x) => s + x.houseCents, 0);

  return (
    <div>
      <div className="relative flex gap-3">
        <div className="tabular flex w-20 shrink-0 flex-col justify-between py-0.5 text-right text-[11px] text-muted" aria-hidden="true">
          <span>{top > 0 ? formatMoney(top) : ''}</span>
          <span>{bottom < 0 ? `−${formatMoney(-bottom)}` : ''}</span>
        </div>
        <div className="relative h-44 flex-1" onMouseLeave={() => setHover(null)}>
          <div className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${zero}%` }} />
          <div className="absolute inset-0 flex gap-[2px]">
            {days.map((x, i) => {
              const size = (Math.abs(x.houseCents) / span) * 100;
              return (
                <div key={x.day} className="relative h-full flex-1" onMouseEnter={() => setHover(i)}>
                  {hover === i && <div className="absolute inset-0 rounded bg-field/70" />}
                  {x.houseCents !== 0 && (
                    <div
                      className={cx('absolute inset-x-[15%] mx-auto max-w-8', x.houseCents > 0 ? 'rounded-t bg-up' : 'rounded-b bg-down')}
                      style={x.houseCents > 0 ? { bottom: `${100 - zero}%`, height: `${size}%` } : { top: `${zero}%`, height: `${size}%` }}
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
              <p className="font-semibold">{dayLabel(h.day)}</p>
              <p className="mt-1 flex justify-between gap-2">
                <span className="text-muted">Casa</span>
                <span className={cx('tabular font-semibold', tone(h.houseCents))}>{formatSignedMoney(h.houseCents)}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span className="text-muted">Entradas</span>
                <span className="tabular">{h.entries}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span className="text-muted">Volume</span>
                <span className="tabular">{formatMoney(h.volumeCents)}</span>
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between pl-23 text-[11px] text-muted">
        <span aria-hidden="true">{days[0] ? dayLabel(days[0].day) : ''}</span>
        <span>
          Total 30 dias: <span className={cx('tabular font-semibold', tone(total))}>{formatSignedMoney(total)}</span>
        </span>
        <span aria-hidden="true">{days.at(-1) ? dayLabel(days.at(-1)!.day) : ''}</span>
      </div>
    </div>
  );
}

function ClientList({ title, hint, rows, empty }: { title: string; hint: string; rows: HouseClientResult[]; empty: string }) {
  return (
    <Card>
      <div className="border-b border-border px-4 py-3">
        <h3 className="font-semibold text-text">{title}</h3>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p>
      ) : (
        <ol className="divide-y divide-border">
          {rows.map((r, i) => (
            <li key={r.userId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="tabular w-5 text-right text-xs text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-text">{r.name}</div>
                <div className="truncate text-xs text-muted">
                  {r.email} · {r.entries} entradas · {formatMoney(r.volumeCents)}
                </div>
              </div>
              <span className={cx('tabular shrink-0 text-sm font-bold', tone(r.netCents))}>{formatSignedMoney(r.netCents)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
