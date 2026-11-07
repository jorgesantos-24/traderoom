import { useState } from 'react';
import { cx } from './ui';

/** Icons in public/coins (cryptocurrency-icons, CC0). */
const KNOWN = new Set(['btc', 'eth', 'sol', 'bnb', 'xrp', 'doge', 'ada']);

/** OTC stocks with a logo in public/stocks (see its README for sources). */
const STOCKS = new Set([
  'AAPLOTC',
  'AMZNOTC',
  'AXPOTC',
  'DISOTC',
  'FOTC',
  'GOOGLOTC',
  'KOOTC',
  'MCDOTC',
  'METAOTC',
  'MSFTOTC',
  'NFLXOTC',
  'NKEOTC',
  'TSLAOTC',
]);

/** "BTCUSDT" → "btc", "ADAOTC" → "ada". */
export function coinCode(symbol: string): string {
  return symbol
    .replace(/(OTC)$/i, '')
    .replace(/(USDT|USDC|USD|BUSD)$/i, '')
    .toLowerCase();
}

/** Round coin logo; falls back to the ticker's first letter when there is no icon. */
export function CoinIcon({ symbol, className }: { symbol: string; className?: string }) {
  const code = coinCode(symbol);
  const [broken, setBroken] = useState(false);
  if (STOCKS.has(symbol)) {
    return (
      <img
        src={`/stocks/${symbol.toLowerCase()}.svg`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cx('size-5 shrink-0 rounded-full', className)}
      />
    );
  }
  if (symbol === 'BULLIDX' || symbol === 'BEARIDX') {
    const bull = symbol === 'BULLIDX';
    return (
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
          bull ? 'bg-up/20 text-up' : 'bg-down/20 text-down',
          className,
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-[60%]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {bull ? <path d="M4 17l6-6 4 4 6-8M14 7h6v6" /> : <path d="M4 7l6 6 4-4 6 8M14 17h6v-6" />}
        </svg>
      </span>
    );
  }
  if (!KNOWN.has(code) || broken) {
    return (
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-border text-[10px] font-bold text-text uppercase',
          className,
        )}
      >
        {code.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={`/coins/${code}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setBroken(true)}
      className={cx('size-5 shrink-0 rounded-full', className)}
    />
  );
}
