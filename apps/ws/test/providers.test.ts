import { describe, expect, it } from 'vitest';
import { binanceSpec } from '../src/feed/providers.js';
import type { FeedAsset } from '../src/feed/types.js';

const assets: FeedAsset[] = [
  { id: 1, symbol: 'BTCUSDT', binanceStream: 'btcusdt@bookTicker' },
  { id: 2, symbol: 'ETHUSDT', binanceStream: 'ethusdt@bookTicker' },
  { id: 6, symbol: 'DOGEUSDT', binanceStream: 'dogeusdt@bookTicker' },
];

describe('provider specs', () => {
  it('builds one Binance combined-stream URL for all assets', () => {
    const spec = binanceSpec('wss://data-stream.binance.vision:443/stream', assets);
    expect(spec?.name).toBe('binance');
    expect(spec?.url).toBe('wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/dogeusdt@bookTicker');
    expect(spec?.onOpenMessages).toEqual([]);
  });

  it('builds the backup endpoint with the same streams and tags its ticks', () => {
    const spec = binanceSpec('wss://stream.binance.com:443/stream', assets, 'binance_backup');
    expect(spec?.name).toBe('binance_backup');
    expect(spec?.url).toBe('wss://stream.binance.com/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/dogeusdt@bookTicker');
    const raw = JSON.stringify({ stream: 'dogeusdt@bookTicker', data: { u: 1, s: 'DOGEUSDT', b: '0.2', B: '1', a: '0.2', A: '1' } });
    expect(spec?.parse(raw, 5)).toMatchObject({ kind: 'tick', tick: { symbol: 'DOGEUSDT', provider: 'binance_backup' } });
  });

  describe('trade-priced assets', () => {
    const traded: FeedAsset[] = [
      { id: 3, symbol: 'SOLUSDT', binanceStream: 'solusdt@aggTrade' },
      { id: 1, symbol: 'BTCUSDT', binanceStream: 'btcusdt@bookTicker' },
    ];
    const book = (s: string, b: string, a: string) =>
      JSON.stringify({ stream: `${s.toLowerCase()}@bookTicker`, data: { u: 1, s, b, B: '1', a, A: '1' } });
    const agg = (s: string, p: string, T: number) =>
      JSON.stringify({ stream: `${s.toLowerCase()}@aggTrade`, data: { e: 'aggTrade', E: T, s, a: 1, p, q: '1', T } });
    const kline = (s: string, c: string, E: number) =>
      JSON.stringify({ stream: `${s.toLowerCase()}@kline_1s`, data: { e: 'kline', E, s, k: { i: '1s', o: c, h: c, l: c, c, x: false } } });

    it('adds the kline_1s heartbeat only for trade streams', () => {
      expect(binanceSpec('wss://x/stream', traded)?.url).toBe(
        'wss://x/stream?streams=solusdt@aggTrade/solusdt@kline_1s/btcusdt@bookTicker',
      );
    });

    it('prices at the last trade and lets klines re-confirm it without changing it', () => {
      const spec = binanceSpec('wss://x/stream', traded);
      expect(spec?.parse(agg('SOLUSDT', '90.20000000', 50), 60)).toMatchObject({
        kind: 'tick',
        tick: { symbol: 'SOLUSDT', price: '90.20000000', ts: 50, recvMs: 60 },
      });
      // A second passes without a trade: still 90.20 and its trade time, with a fresh receive time.
      expect(spec?.parse(kline('SOLUSDT', '90.20000000', 1000), 1010)).toEqual({
        kind: 'tick',
        tick: { symbol: 'SOLUSDT', price: '90.20000000', value: 90.2, ts: 50, recvMs: 1010, provider: 'binance' },
      });
      // The book is ignored for trade-priced assets (its mid is not what Binance shows).
      expect(spec?.parse(book('SOLUSDT', '90.21', '90.22'), 1100)).toEqual({ kind: 'ignore' });
      // A bookTicker-only asset keeps the mid.
      expect(spec?.parse(book('BTCUSDT', '100', '102'), 5)).toMatchObject({ kind: 'tick', tick: { price: '101.00000000' } });
    });

    it('seeds the price from the kline close before the first trade on a connection', () => {
      const spec = binanceSpec('wss://x/stream', traded);
      expect(spec?.parse(kline('SOLUSDT', '90.21000000', 1000), 1010)).toEqual({
        kind: 'tick',
        tick: { symbol: 'SOLUSDT', price: '90.21000000', value: 90.21, ts: 1000, recvMs: 1010, provider: 'binance' },
      });
      // A trade from before that kline is already in it: dropped, so later heartbeats keep working.
      expect(spec?.parse(agg('SOLUSDT', '90.19000000', 990), 1020)).toEqual({ kind: 'ignore' });
      expect(spec?.parse(kline('SOLUSDT', '90.21000000', 2000), 2010)).toMatchObject({ tick: { ts: 1000, recvMs: 2010 } });
      expect(spec?.parse(agg('SOLUSDT', '90.22000000', 2100), 2110)).toMatchObject({ tick: { price: '90.22000000', ts: 2100 } });
    });

    it('never revives a trade from a previous connection', () => {
      const first = binanceSpec('wss://x/stream', traded);
      first?.parse(agg('SOLUSDT', '90.20000000', 50), 60);
      const reconnected = binanceSpec('wss://x/stream', traded);
      // The new connection starts from Binance's current close, not the old trade.
      expect(reconnected?.parse(kline('SOLUSDT', '91.00000000', 5000), 5010)).toMatchObject({
        tick: { price: '91.00000000', ts: 5000 },
      });
    });
  });

  it('returns null when there is nothing to subscribe', () => {
    expect(binanceSpec('wss://x/stream', [])).toBeNull();
    expect(binanceSpec('wss://x/stream', [], 'binance_backup')).toBeNull();
  });
});
