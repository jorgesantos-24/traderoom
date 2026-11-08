import type { FeedProvider } from '@traderoom/shared';
import type { OtcParams } from './otc.js';

export type { FeedProvider };

export const PRIMARY_PROVIDER: FeedProvider = 'binance';
export const FALLBACK_PROVIDER: FeedProvider = 'binance_backup';

/** One trade from a provider, already mapped to our symbol (e.g. BTCUSDT). */
export interface Tick {
  symbol: string;
  /** Exact decimal string from the provider. */
  price: string;
  /** `price` as a number, for frames and comparisons. */
  value: number;
  /** Exchange trade time, epoch ms. */
  ts: number;
  /** Local receive time, epoch ms. */
  recvMs: number;
  provider: FeedProvider;
  /** Set when a price override changed `price`: the otc_overrides id. */
  ov?: string;
  /** With `ov`: the price without the override (what the provider sent, or the OTC natural path). */
  realPrice?: string;
}

export interface FeedAsset {
  id: number;
  symbol: string;
  /** Empty for OTC assets. */
  binanceStream: string;
  /** Set for OTC assets: priced by our generator, not by Binance. */
  otc?: OtcParams;
  /** Market assets: assets.price_decimals, the grid of override targets and of the chart. Null if unset. */
  priceDecimals?: number | null;
}

export type ParseResult =
  /** `quote` marks a bid/ask mid (bookTicker), `kline` a candle close; neither is set for a trade. */
  | { kind: 'tick'; tick: Tick; quote?: true; kline?: true }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

/** Everything a connection needs to talk to one provider. */
export interface ProviderSpec {
  name: FeedProvider;
  url: string;
  /** Sent right after the socket opens (e.g. a subscribe request). */
  onOpenMessages: string[];
  parse(raw: string, recvMs: number): ParseResult;
}
