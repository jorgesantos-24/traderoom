import { useEffect } from 'react';
import { formatMoney, formatSignedMoney } from '../lib/format';
import { netCents } from '../lib/orders';
import type { ResultToast } from '../lib/use-trade-orders';
import { CoinIcon } from './CoinIcon';
import { cx } from './ui';

export const RESULT_CARD_MS = 5000;

/**
 * Result cards stacked bottom-left, one per settled order, newest at the bottom. Each slides in,
 * shows the net result (a win in a green card with a shine and a draining bar) and closes itself
 * after 5 s or on its close button.
 */
export function ResultToasts({ results, onDismiss }: { results: readonly ResultToast[]; onDismiss(key: string): void }) {
  if (results.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-4 z-50 flex w-[min(340px,calc(100vw-2rem))] flex-col-reverse gap-2"
      data-testid="result-popup"
    >
      {results.map((r) => (
        <ResultCard key={r.key} result={r} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ResultCard({ result, onDismiss }: { result: ResultToast; onDismiss(key: string): void }) {
  const { key, order, display } = result;
  useEffect(() => {
    const id = setTimeout(() => onDismiss(key), RESULT_CARD_MS);
    return () => clearTimeout(id);
  }, [key, onDismiss]);

  const won = order.status === 'won';
  const voided = order.status === 'void';
  const net = netCents(order);

  return (
    <div
      role="status"
      className={cx(
        'result-card pointer-events-auto relative flex h-14 items-center gap-2.5 overflow-hidden rounded-lg px-3 shadow-xl',
        won ? 'result-card-won' : 'border border-border bg-surface',
      )}
    >
      {won && <span aria-hidden="true" className="result-shine" />}
      <span aria-hidden="true" className="result-drain" style={{ animationDuration: `${RESULT_CARD_MS}ms` }} />
      <CoinIcon symbol={order.symbol} className="relative size-7" />
      <span className={cx('relative min-w-0 flex-1 truncate text-sm font-semibold', won ? 'text-white' : 'text-text')}>{display}</span>
      <span className={cx('tabular relative text-sm font-bold', won ? 'text-white' : 'text-muted')} data-testid="result-amount">
        {voided ? `${formatMoney(0)} · devolvido` : formatSignedMoney(net)}
      </span>
      <button
        type="button"
        onClick={() => onDismiss(key)}
        aria-label="Fechar"
        className={cx(
          'relative -mr-1 flex size-7 items-center justify-center rounded-md text-base leading-none',
          won ? 'text-white/80 hover:bg-white/15' : 'text-muted hover:bg-border',
        )}
      >
        ×
      </button>
    </div>
  );
}
