import { describe, expect, it } from 'vitest';
import { parseBinanceMessage } from '../src/feed/parsers.js';

const RECV = 1_793_217_464_250;

describe('parseBinanceMessage', () => {
  const trade = (data: Record<string, unknown>) =>
    JSON.stringify({
      stream: 'btcusdt@trade',
      data: { e: 'trade', E: 1, s: 'BTCUSDT', t: 9, p: '75552.63000000', q: '0.01', T: 1_793_217_464_000, ...data },
    });

  it('parses a combined-stream trade', () => {
    expect(parseBinanceMessage(trade({}), RECV)).toEqual({
      kind: 'tick',
      tick: {
        symbol: 'BTCUSDT',
        price: '75552.63000000',
        value: 75552.63,
        ts: 1_793_217_464_000,
        recvMs: RECV,
        provider: 'binance',
      },
    });
  });

  it('parses a kline as its close at the event time, flagged as kline', () => {
    const raw = JSON.stringify({
      stream: 'adausdt@kline_1s',
      data: { e: 'kline', E: 1_793_217_465_000, s: 'ADAUSDT', k: { i: '1s', c: '0.51230000', x: false } },
    });
    expect(parseBinanceMessage(raw, RECV)).toEqual({
      kind: 'tick',
      tick: { symbol: 'ADAUSDT', price: '0.51230000', value: 0.5123, ts: 1_793_217_465_000, recvMs: RECV, provider: 'binance' },
      kline: true,
    });
    expect(parseBinanceMessage(JSON.stringify({ data: { e: 'kline', E: 1, s: 'ADAUSDT', k: {} } }), RECV)).toEqual({
      kind: 'error',
      message: 'malformed kline event',
    });
  });

  it('accepts aggTrade events', () => {
    expect(parseBinanceMessage(trade({ e: 'aggTrade' }), RECV).kind).toBe('tick');
  });

  it('ignores other events and non-data messages', () => {
    expect(parseBinanceMessage(trade({ e: 'depthUpdate' }), RECV)).toEqual({ kind: 'ignore' });
    expect(parseBinanceMessage(JSON.stringify({ result: null, id: 1 }), RECV)).toEqual({ kind: 'ignore' });
  });

  it('reports server errors and bad JSON', () => {
    expect(parseBinanceMessage(JSON.stringify({ error: { code: 2, msg: 'Invalid request' } }), RECV)).toMatchObject({
      kind: 'error',
    });
    expect(parseBinanceMessage('{not json', RECV)).toEqual({ kind: 'error', message: 'invalid JSON' });
    expect(parseBinanceMessage('[1,2]', RECV)).toEqual({ kind: 'error', message: 'invalid JSON' });
  });

  it.each([
    ['negative price', { p: '-1' }],
    ['zero price', { p: '0.00000000' }],
    ['exponent price', { p: '1e5' }],
    ['numeric price', { p: 75552.63 }],
    ['missing time', { T: undefined }],
    ['string time', { T: '1793217464000' }],
    ['missing symbol', { s: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(parseBinanceMessage(trade(patch), RECV)).toEqual({ kind: 'error', message: 'malformed trade event' });
  });
});

describe('parseBinanceMessage (bookTicker)', () => {
  const quote = (data: Record<string, unknown>) =>
    JSON.stringify({
      stream: 'btcusdt@bookTicker',
      data: { u: 400900217, s: 'BTCUSDT', b: '75552.62000000', B: '1.2', a: '75552.64000000', A: '0.3', ...data },
    });

  it('prices a quote at the exact mid, timestamped on receive', () => {
    expect(parseBinanceMessage(quote({}), RECV)).toEqual({
      kind: 'tick',
      tick: { symbol: 'BTCUSDT', price: '75552.63000000', value: 75552.63, ts: RECV, recvMs: RECV, provider: 'binance' },
      quote: true,
    });
  });

  it('skips a crossed book', () => {
    expect(parseBinanceMessage(quote({ b: '10.0', a: '9.9' }), RECV)).toEqual({ kind: 'ignore' });
  });

  it.each([
    ['empty bid', { b: '0.00000000' }],
    ['bad ask', { a: 'x' }],
    ['numeric bid', { b: 75552.62 }],
    ['missing symbol', { s: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(parseBinanceMessage(quote(patch), RECV)).toEqual({ kind: 'error', message: 'malformed quote' });
  });
});

describe('parseBinanceMessage provider', () => {
  it('tags ticks with the endpoint they came from', () => {
    const raw = JSON.stringify({ stream: 'btcusdt@bookTicker', data: { u: 1, s: 'BTCUSDT', b: '100', B: '1', a: '102', A: '1' } });
    expect(parseBinanceMessage(raw, RECV)).toMatchObject({ kind: 'tick', tick: { provider: 'binance', price: '101.00000000' } });
    expect(parseBinanceMessage(raw, RECV, 'binance_backup')).toMatchObject({
      kind: 'tick',
      tick: { provider: 'binance_backup', price: '101.00000000' },
    });
  });
});
