import type { AssetView, OrderView } from '@traderoom/shared';
import { serverClock } from '../lib/clock';
import { DIRECTION_LABEL, formatCountdown, formatMoney, formatPrice } from '../lib/format';
import { liveResult, msLeft, progress, type LiveResult } from '../lib/orders';
import { useNow, useQuote, type Loadable } from '../lib/session-data';
import { Card, cx, EmptyState, ErrorState, LoadingState } from './ui';
import { CoinIcon } from './CoinIcon';

const serverNow = () => serverClock.serverNow();

const RESULT_TEXT: Record<LiveResult, string> = {
  winning: 'Ganhando',
  losing: 'Perdendo',
  tie: 'Empatando',
  unknown: 'Sem cotação',
};
const RESULT_COLOR: Record<LiveResult, string> = {
  winning: 'text-up',
  losing: 'text-down',
  tie: 'text-muted',
  unknown: 'text-warn',
};

function OpenOrderRow({ order, display, now }: { order: OrderView; display: string; now: number }) {
  const quote = useQuote(order.symbol);
  const result = quote?.stale ? 'unknown' : liveResult(order.direction, order.openPrice, quote?.price ?? null);
  const left = msLeft(order, now);
  const pct = progress(order, now);
  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0" data-testid="open-order">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-medium">
          <CoinIcon symbol={order.symbol} className="size-4" />
          {display}{' '}
          <span className={order.direction === 'call' ? 'text-up' : 'text-down'}>
            {order.direction === 'call' ? '▲' : '▼'} {DIRECTION_LABEL[order.direction]}
          </span>
        </span>
        <span className="tabular text-muted" aria-label={`Tempo restante ${formatCountdown(left)}`}>
          {left > 0 ? formatCountdown(left) : 'Liquidando…'}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label="Tempo decorrido"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
      >
        <div className="h-full bg-brand" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-muted">Valor</div>
          <div className="tabular">{formatMoney(order.stakeCents)}</div>
        </div>
        <div>
          <div className="text-muted">Abertura</div>
          <div className="tabular">{formatPrice(order.openPrice)}</div>
        </div>
        <div className="text-right">
          <div className="text-muted">Agora</div>
          <div className={cx('tabular font-semibold', RESULT_COLOR[result])}>
            {RESULT_TEXT[result]}
            {result === 'winning' && <span className="sr-only">, retorno de {formatMoney(order.potentialPayoutCents)}</span>}
          </div>
        </div>
      </div>
    </li>
  );
}

export function OpenOrders({ open, assets, onRetry }: { open: Loadable<OrderView[]>; assets: readonly AssetView[]; onRetry(): void }) {
  const now = useNow(250, serverNow);
  const display = new Map(assets.map((a) => [a.symbol, a.display]));
  const name = (s: string) => display.get(s) ?? s;
  return (
    <Card className="flex flex-col" aria-labelledby="open-orders-title">
      <h2 id="open-orders-title" className="border-b border-border px-4 py-3 text-base font-semibold">
        Ordens abertas
        {open.status === 'ready' && open.data.length > 0 && <span className="ml-2 text-sm text-muted">({open.data.length})</span>}
      </h2>
      {open.status === 'loading' && <LoadingState label="Carregando ordens…" />}
      {open.status === 'error' && <ErrorState message={open.message} onRetry={onRetry} />}
      {open.status === 'ready' && open.data.length === 0 && (
        <EmptyState title="Nenhuma ordem aberta" hint="Escolha valor e duração e clique em Comprar ou Vender." />
      )}
      {open.status === 'ready' && open.data.length > 0 && (
        <ul>
          {open.data.map((o) => (
            <OpenOrderRow key={o.id} order={o} display={name(o.symbol)} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}
