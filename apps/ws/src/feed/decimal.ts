/** Exact decimal helpers for price strings like "75552.63000000" (no floats involved). */

export const PRICE_DECIMALS = 8;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function decimals(s: string): number {
  const m = DECIMAL.exec(s);
  return m?.[2]?.length ?? 0;
}

function toScaled(s: string, scale: number): bigint {
  const m = DECIMAL.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = (m[2] ?? '').padEnd(scale, '0');
  return BigInt(`${m[1] ?? '0'}${frac}`);
}

function format(v: bigint, scale: number): string {
  const s = v.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/**
 * (bid + ask) / 2 rounded half-up to 8 decimals, the precision of `numeric(20,8)`.
 * Both inputs must be plain non-negative decimal strings.
 */
export function midPrice(bid: string, ask: string): string {
  const scale = Math.max(decimals(bid), decimals(ask), PRICE_DECIMALS);
  const sum = toScaled(bid, scale) + toScaled(ask, scale);
  // Result at 8 decimals = round(sum / (2 * 10^(scale-8))). Divisor is even, so half is exact.
  const div = 2n * 10n ** BigInt(scale - PRICE_DECIMALS);
  return format((sum + div / 2n) / div, PRICE_DECIMALS);
}
