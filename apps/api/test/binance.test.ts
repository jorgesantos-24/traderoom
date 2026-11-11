import { describe, expect, it } from 'vitest';
import { createKlinesFetcher, parseKlines, retryAfterMs, UpstreamError } from '../src/lib/binance.js';

const ROW = [
  1_793_217_420_000,
  '75500.10',
  '75600.00',
  '75450.00',
  '75552.63',
  '12.345',
  1_793_217_479_999,
  '932000.1',
  1234,
  '6.1',
  '460000.2',
  '0',
];

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('parseKlines', () => {
  it('maps Binance rows to numeric candles', () => {
    expect(parseKlines([ROW])).toEqual([{ t: 1_793_217_420_000, o: 75500.1, h: 75600, l: 75450, c: 75552.63, v: 12.345 }]);
  });

  it('rejects malformed payloads', () => {
    expect(() => parseKlines({ code: -1121, msg: 'Invalid symbol.' })).toThrow();
    expect(() => parseKlines([[1, 'x', '1', '1', '1', '1']])).toThrow();
    expect(() => parseKlines([[1, '1', '1']])).toThrow();
  });
});

describe('retryAfterMs', () => {
  it('converts seconds and falls back to 60 s', () => {
    expect(retryAfterMs('12')).toBe(12_000);
    expect(retryAfterMs(null)).toBe(60_000);
    expect(retryAfterMs('soon')).toBe(60_000);
    expect(retryAfterMs('999999')).toBe(3_600_000);
  });
});

describe('createKlinesFetcher', () => {
  it('calls /api/v3/klines with symbol, interval and limit', async () => {
    const f = fakeFetch(200, [ROW]);
    const fetchKlines = createKlinesFetcher('https://data-api.binance.vision', { fetchImpl: f.impl });
    const candles = await fetchKlines('BTCUSDT', '1m', 1000);
    expect(candles).toHaveLength(1);
    expect(f.calls[0]?.toString()).toBe('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000');
  });

  it('asks for candles before a time with endTime (exclusive)', async () => {
    const f = fakeFetch(200, [ROW]);
    await createKlinesFetcher('https://data-api.binance.vision', { fetchImpl: f.impl })('BTCUSDT', '1h', 1000, 1_800_000_000_000);
    expect(f.calls[0]?.toString()).toBe(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000&endTime=1799999999999',
    );
  });

  it('reports every upstream status, including network failures', async () => {
    const seen: Array<number | 'error'> = [];
    const ok = createKlinesFetcher('https://x.test', { fetchImpl: fakeFetch(200, [ROW]).impl, onStatus: (s) => seen.push(s) });
    await ok('BTCUSDT', '1m', 1);
    const limited = createKlinesFetcher('https://x.test', { fetchImpl: fakeFetch(429, {}).impl, onStatus: (s) => seen.push(s) });
    await limited('BTCUSDT', '1m', 1).catch(() => {});
    const down = createKlinesFetcher('https://x.test', {
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      onStatus: (s) => seen.push(s),
    });
    await down('BTCUSDT', '1m', 1).catch(() => {});
    expect(seen).toEqual([200, 429, 'error']);
  });

  it.each([429, 418])('turns %i into a back-off error with Retry-After', async (status) => {
    const f = fakeFetch(status, { code: -1003 }, { 'retry-after': '30' });
    const fetchKlines = createKlinesFetcher('https://x.test', { fetchImpl: f.impl });
    const err = await fetchKlines('BTCUSDT', '1m', 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ status, retryAfterMs: 30_000 });
  });

  it('reports other HTTP errors without a back-off', async () => {
    const f = fakeFetch(500, {});
    const err = await createKlinesFetcher('https://x.test', { fetchImpl: f.impl })('BTCUSDT', '1m', 10).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'UpstreamError', status: 500, retryAfterMs: undefined });
  });

  it('reports network failures and timeouts', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(createKlinesFetcher('https://x.test', { fetchImpl: impl })('BTCUSDT', '1m', 10)).rejects.toThrow(
      'klines request failed: fetch failed',
    );
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(createKlinesFetcher('https://x.test', { fetchImpl: hang, timeoutMs: 30 })('BTCUSDT', '1m', 10)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});
