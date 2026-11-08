import { describe, expect, it } from 'vitest';
import {
  awesomeApi,
  binanceUsdtBrl,
  openErApi,
  brlToUsdCents,
  createFxService,
  FxUnavailableError,
  usdToBrlCents,
  type RateSource,
} from '../src/lib/fx.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fixed =
  (bid: number, ask: number, source = 's'): RateSource =>
  async () => ({ bid, ask, source });
const failing: RateSource = async () => {
  throw new Error('down');
};

describe('conversion', () => {
  it('rounds down both ways', () => {
    expect(brlToUsdCents(10_000, 5.5035)).toBe(1817); // R$ 100 → US$ 18,17
    expect(brlToUsdCents(5000, 5)).toBe(1000);
    expect(usdToBrlCents(1000, 5.503)).toBe(5503);
    expect(usdToBrlCents(3900, 4.9)).toBe(19_110);
    expect(brlToUsdCents(19_110, 4.9)).toBe(3900);
  });
});

describe('sources', () => {
  it('parses AwesomeAPI', async () => {
    const f = (async () => json({ USDBRL: { bid: '5.503', ask: '5.5035' } })) as typeof fetch;
    expect(await awesomeApi(f, 1000)).toEqual({ bid: 5.503, ask: 5.5035, source: 'awesomeapi' });
  });
  it('parses open.er-api', async () => {
    const f = (async () => json({ result: 'success', rates: { BRL: 5.502723, EUR: 0.9 } })) as typeof fetch;
    expect(await openErApi(f, 1000)).toEqual({ bid: 5.502723, ask: 5.502723, source: 'open-er-api' });
  });
  it('parses the Binance book ticker and rejects nonsense', async () => {
    const ok = (async () => json({ bidPrice: '5.6100', askPrice: '5.6130' })) as typeof fetch;
    expect(await binanceUsdtBrl('https://x.test')(ok, 1000)).toMatchObject({ bid: 5.61, ask: 5.613 });
    const bad = (async () => json({ bidPrice: '0', askPrice: 'abc' })) as typeof fetch;
    await expect(binanceUsdtBrl('https://x.test')(bad, 1000)).rejects.toThrow();
    const err = (async () => json({}, 500)) as typeof fetch;
    await expect(awesomeApi(err, 1000)).rejects.toThrow();
  });
});

describe('createFxService', () => {
  it('applies the spread to each side and caches', async () => {
    let calls = 0;
    let t = 0;
    const src: RateSource = async () => {
      calls++;
      return { bid: 5, ask: 5.1, source: 'a' };
    };
    const fx = createFxService({ sources: [src], spreadPct: 1, cacheMs: 1000, now: () => t });
    expect(await fx.quote()).toMatchObject({ depositRate: 5.151, withdrawRate: 4.95, source: 'a' });
    t = 500;
    await fx.quote();
    expect(calls).toBe(1);
    t = 1500;
    await fx.quote();
    expect(calls).toBe(2);
  });

  it('falls back to the next source, then to a recent quote, then gives up', async () => {
    let t = 0;
    let up = true;
    const first: RateSource = async () => {
      if (!up) throw new Error('down');
      return { bid: 5, ask: 5, source: 'first' };
    };
    const errors: unknown[] = [];
    const fx = createFxService({ sources: [failing, first], cacheMs: 10, maxStaleMs: 100, now: () => t, onError: (e) => errors.push(e) });
    expect((await fx.quote()).source).toBe('first');
    expect(errors).toHaveLength(1);
    up = false;
    t = 50;
    expect((await fx.quote()).depositRate).toBe(5);
    t = 200;
    await expect(fx.quote()).rejects.toBeInstanceOf(FxUnavailableError);
    expect(await createFxService({ sources: [fixed(5, 5.2)] }).quote()).toMatchObject({ depositRate: 5.2, withdrawRate: 5 });
  });

  it('skips a failing source while it cools down', async () => {
    let t = 0;
    let calls = 0;
    const limited: RateSource = async () => {
      calls++;
      throw new Error('429');
    };
    const fx = createFxService({ sources: [limited, fixed(5, 5, 'b')], cacheMs: 0, cooldownMs: 1000, now: () => t });
    await fx.quote();
    t = 10;
    expect((await fx.quote()).source).toBe('b');
    expect(calls).toBe(1);
    t = 2000;
    await fx.quote();
    expect(calls).toBe(2);
  });
});
