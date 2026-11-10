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

/** Currencies with a flag in public/flags. */
const FLAGS = new Set([
  'aed',
  'ars',
  'aud',
  'bdt',
  'bob',
  'brl',
  'cad',
  'chf',
  'clp',
  'cop',
  'dop',
  'eur',
  'gbp',
  'hkd',
  'idr',
  'inr',
  'jpy',
  'mxn',
  'myr',
  'ngn',
  'nok',
  'nzd',
  'pen',
  'php',
  'pln',
  'sar',
  'sek',
  'sgd',
  'thb',
  'try',
  'usd',
  'vnd',
  'zar',
]);

/** "EURUSDOTC" → ["eur", "usd"]; null when it is not a currency pair with both flags. */
export function forexPair(symbol: string): [string, string] | null {
  const m = /^([A-Z]{3})([A-Z]{3})OTC$/.exec(symbol);
  if (!m) return null;
  const base = (m[1] as string).toLowerCase();
  const quote = (m[2] as string).toLowerCase();
  return FLAGS.has(base) && FLAGS.has(quote) ? [base, quote] : null;
}

/** Round coin logo; falls back to the ticker's first letter when there is no icon. */
export function CoinIcon({ symbol, className }: { symbol: string; className?: string }) {
  const code = coinCode(symbol);
  const [broken, setBroken] = useState(false);
  const pair = forexPair(symbol);
  if (pair) {
    // Two flags, base top-left and quote bottom-right, as currency pairs usually show.
    const flag = 'absolute size-[68%] rounded-full object-cover ring-1 ring-black/40';
    return (
      <span aria-hidden="true" className={cx('relative inline-block size-5 shrink-0', className)}>
        <img src={`/flags/${pair[0]}.svg`} alt="" draggable={false} className={cx(flag, 'top-0 left-0')} />
        <img src={`/flags/${pair[1]}.svg`} alt="" draggable={false} className={cx(flag, 'right-0 bottom-0')} />
      </span>
    );
  }
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
