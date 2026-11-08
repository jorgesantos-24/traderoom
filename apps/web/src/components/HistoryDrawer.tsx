import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { OrderView } from '@traderoom/shared';
import { api } from '../lib/api';
import { formatMoney, formatPrice, formatShortDate, formatSignedMoney, formatTime } from '../lib/format';
import { netCents } from '../lib/orders';
import { requestOpenAsset } from '../lib/open-asset';
import { navigate, useLocation } from '../lib/router';
import { useSessionData } from '../lib/session-data';
import { usePaged } from '../lib/use-paged';
import { CoinIcon } from './CoinIcon';
import { PagedFooter } from './PagedFooter';
import { cx, EmptyState, ErrorState, LoadingState } from './ui';

const RESULT_COLOR = { open: 'text-muted', won: 'text-up', lost: 'text-down', void: 'text-muted' } as const;

/** Amount on the second line of a row: what came back on a win, the stake lost on a loss. */
function rowResult(o: OrderView): string {
  if (o.status === 'open') return 'Em andamento';
  if (o.status === 'void') return 'Devolvido';
  if (o.status === 'won') return `+${formatMoney(o.payoutCents)}`;
  return `−${formatMoney(o.stakeCents)}`;
}

function Arrow({ direction, className }: { direction: OrderView['direction']; className?: string }) {
  const up = direction === 'call';
  return (
    <svg
      aria-label={up ? 'Compra' : 'Venda'}
      role="img"
      viewBox="0 0 24 24"
      className={cx('size-4', up ? 'text-up' : 'text-down', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {up ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}
    </svg>
  );
}

/**
 * Operations panel that slides in from the left, next to the sidebar: a compact
 * list (open on top, then closed) and a detail view per operation.
 * Re-fetched every time it opens (`openCount` remounts the content).
 */
export function HistoryDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const [openCount, setOpenCount] = useState(0);
  const [selected, setSelected] = useState<OrderView | null>(null);
  const { catalog } = useSessionData();
  const display = new Map(catalog.status === 'ready' ? catalog.data.assets.map((a) => [a.symbol, a.display]) : []);
  const name = (s: string) => display.get(s) ?? s;

  useEffect(() => {
    if (!open) return;
    setOpenCount((n) => n + 1);
    setSelected(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cx(
          'absolute inset-0 z-30 bg-bg/60 transition-opacity duration-300',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        id="history-drawer"
        aria-label="Operações"
        aria-hidden={!open}
        inert={!open}
        className={cx(
          'absolute inset-y-0 left-0 z-40 flex w-[min(360px,100vw)] md:w-[min(360px,calc(100vw-76px))] flex-col border-r border-border bg-bg shadow-2xl',
          'transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-medium">
            {selected ? (
              <>
                <button type="button" onClick={() => setSelected(null)} className="text-muted hover:text-text">
                  Operações
                </button>
                <span aria-hidden="true" className="text-muted">
                  ›
                </span>
                <span className="truncate">{name(selected.symbol)}</span>
              </>
            ) : (
              'Operações'
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar operações"
            className="rounded-control px-2 py-1 text-muted hover:bg-field hover:text-text"
          >
            ✕
          </button>
        </div>
        {openCount > 0 && (
          <>
            <div className={cx('flex min-h-0 flex-1 flex-col', selected && 'hidden')}>
              <OperationsList key={openCount} name={name} onSelect={setSelected} />
            </div>
            {selected && (
              <OperationDetail
                order={selected}
                name={name(selected.symbol)}
                onTrade={() => {
                  requestOpenAsset(selected.symbol);
                  onClose();
                }}
              />
            )}
          </>
        )}
      </aside>
    </>
  );
}

function OperationsList({ name, onSelect }: { name(symbol: string): string; onSelect(o: OrderView): void }) {
  const { account } = useSessionData();
  const fetchPage = useCallback((cursor?: string) => api.orders({ account, cursor, limit: 50 }), [account]);
  const orders = usePaged<OrderView>(fetchPage, `all:${account}`);
  const openOnes = orders.items.filter((o) => o.status === 'open');
  const closed = orders.items.filter((o) => o.status !== 'open');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {orders.status === 'loading' && <LoadingState label="Carregando operações…" />}
      {orders.status === 'error' && <ErrorState message={orders.error ?? ''} onRetry={orders.reload} />}
      {orders.status === 'ready' && orders.items.length === 0 && (
        <EmptyState title="Nenhuma operação ainda" hint="Suas operações aparecem aqui assim que forem abertas." />
      )}
      {openOnes.length > 0 && <Section title="Abertas" items={openOnes} name={name} onSelect={onSelect} />}
      {closed.length > 0 && <Section title="Encerradas" items={closed} name={name} onSelect={onSelect} />}
      <PagedFooter paged={orders} />
    </div>
  );
}

function Section({
  title,
  items,
  name,
  onSelect,
}: {
  title: string;
  items: OrderView[];
  name(symbol: string): string;
  onSelect(o: OrderView): void;
}) {
  return (
    <section>
      <h3 className="border-b border-border px-4 py-2.5 text-xs text-muted">{title}</h3>
      <ul>
        {items.map((o) => (
          <li key={o.id} className="border-b border-border" data-testid="history-row">
            <button type="button" onClick={() => onSelect(o)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-field">
              <span className="w-[68px] shrink-0">
                <span className="tabular block text-sm font-semibold text-text">{formatTime(o.opensAt)}</span>
                <span className="tabular block text-xs text-muted">{formatShortDate(o.opensAt)}</span>
              </span>
              <CoinIcon symbol={o.symbol} className="size-5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text">{name(o.symbol)}</span>
                <span className="block text-xs text-muted">{o.payoutPct}%</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular flex items-center justify-end gap-1.5 text-sm font-semibold text-text">
                  <Arrow direction={o.direction} />
                  {formatMoney(o.stakeCents)}
                </span>
                <span className={cx('tabular block text-xs font-medium', RESULT_COLOR[o.status])}>{rowResult(o)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OperationDetail({ order: o, name, onTrade }: { order: OrderView; name: string; onTrade(): void }) {
  const { pathname } = useLocation();
  const [copied, setCopied] = useState(false);
  const net = netCents(o);
  const pct = o.status === 'open' || o.status === 'void' ? null : (net / o.stakeCents) * 100;
  const color = RESULT_COLOR[o.status];

  const copyId = () => {
    void navigator.clipboard?.writeText(o.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-4 border-b border-border px-4 py-5">
          <CoinIcon symbol={o.symbol} className="size-11" />
          <div className="min-w-0">
            <p className="text-lg font-semibold">{name}</p>
            <p className="tabular text-xs text-muted">{formatShortDate(o.opensAt)}</p>
            <p className="flex items-center gap-1 text-xs text-muted">
              <span className="tabular truncate">ID: {o.id.slice(0, 13).toUpperCase()}…</span>
              <button type="button" onClick={copyId} className="rounded px-1 hover:text-text" aria-label="Copiar ID da operação">
                {copied ? '✓' : '⧉'}
              </button>
            </p>
          </div>
        </div>

        <div className="mx-4 border-b border-border py-4">
          <p className="text-xs text-muted">Valor do investimento</p>
          <p className="tabular mt-1 text-lg font-semibold">{formatMoney(o.stakeCents)}</p>
        </div>

        <div className="mx-4 grid grid-cols-2 gap-4 border-b border-border py-4">
          <div>
            <p className="text-xs text-muted">Resultado (P/L)</p>
            <p className={cx('tabular mt-1 text-xl font-semibold', color)}>
              {o.status === 'open' ? '—' : o.status === 'void' ? formatMoney(0) : formatSignedMoney(net)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Resultado %</p>
            <p className={cx('tabular mt-1 text-xl font-semibold', color)}>
              {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}%`}
            </p>
          </div>
        </div>

        <div className="px-4 pt-4 pb-2">
          <h3 className="text-sm font-semibold">Informações da operação</h3>
        </div>
        <dl className="mx-4 text-sm">
          <InfoRow label="Direção">
            <span className="flex items-center gap-1.5">
              <Arrow direction={o.direction} />
              {o.direction === 'call' ? 'Compra' : 'Venda'}
            </span>
          </InfoRow>
          <InfoRow label="Payout">{o.payoutPct}%</InfoRow>
          <InfoRow label="Retorno">
            {o.status === 'open' ? '—' : o.status === 'void' ? `${formatMoney(o.payoutCents)} (devolvido)` : formatMoney(o.payoutCents)}
          </InfoRow>
          <InfoRow label="Abertura">{formatTime(o.opensAt)}</InfoRow>
          <InfoRow label="Fechamento">{formatTime(o.expiresAt)}</InfoRow>
          <InfoRow label="Preço de abertura">{formatPrice(o.openPrice)}</InfoRow>
          <InfoRow label="Preço de fechamento">{o.closePrice ? formatPrice(o.closePrice) : '—'}</InfoRow>
        </dl>
      </div>
      <div className="shrink-0 border-t border-border p-4">
        <button
          type="button"
          onClick={() => {
            onTrade();
            if (pathname !== '/traderoom') navigate('/traderoom');
          }}
          className="w-full rounded-control bg-field py-2.5 text-sm font-medium text-text hover:bg-border"
        >
          Negociar ativo
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular text-right text-text">{children}</dd>
    </div>
  );
}
