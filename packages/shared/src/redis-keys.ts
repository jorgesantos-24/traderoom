/** Redis key names shared between api, ws and worker processes. */
export const RedisKeys = {
  /** Epoch ms of the newest tick received from any provider. Written by the relay. */
  feedLastTickMs: 'feed:last_tick_ms',
  /** Latest conflated price per symbol (JSON `PriceRecord`), TTL 5 s. */
  price: (symbol: string) => `px:${symbol}`,
  /** Settlement schedule: member = order id, score = expires_at in ms. */
  ordersDue: 'orders:due',
  /** Cached Binance klines (JSON) per symbol and interval. */
  candles: (symbol: string, interval: string) => `candles:${symbol}:${interval}`,
  /** Epoch ms until which no REST call may go to Binance (set after a 429/418). */
  binanceRestBackoffUntil: 'binance:rest:backoff_until',
} as const;
