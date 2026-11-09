import { describe, expect, it } from 'vitest';
import { candleExpiry, LATE_ENTRY_MS } from '@traderoom/shared';

const at = (iso: string) => Date.parse(iso);

describe('candle-aligned expiry', () => {
  it('closes at the end of the current 1 min candle when entered in its first 10 s', () => {
    expect(candleExpiry(at('2026-11-09T14:03:00.000Z'), 60)).toEqual({
      candleEndsAt: at('2026-11-09T14:04:00.000Z'),
      late: false,
      closesAt: at('2026-11-09T14:04:00.000Z'),
    });
    expect(candleExpiry(at('2026-11-09T14:03:09.999Z'), 60).late).toBe(false);
  });

  it('runs through the next candle from 50 s left on (the yellow window)', () => {
    const e = candleExpiry(at('2026-11-09T14:03:10.000Z'), 60);
    expect(e).toEqual({ candleEndsAt: at('2026-11-09T14:04:00.000Z'), late: true, closesAt: at('2026-11-09T14:05:00.000Z') });
    expect(candleExpiry(at('2026-11-09T14:03:59.900Z'), 60).closesAt).toBe(at('2026-11-09T14:05:00.000Z'));
  });

  it('uses the same 50 s cut on 5, 15 and 30 min candles', () => {
    expect(candleExpiry(at('2026-11-09T14:04:09.000Z'), 300)).toMatchObject({ late: false, closesAt: at('2026-11-09T14:05:00.000Z') });
    expect(candleExpiry(at('2026-11-09T14:04:10.000Z'), 300)).toMatchObject({ late: true, closesAt: at('2026-11-09T14:10:00.000Z') });
    expect(candleExpiry(at('2026-11-09T14:14:30.000Z'), 900)).toMatchObject({ late: true, closesAt: at('2026-11-09T14:30:00.000Z') });
    expect(candleExpiry(at('2026-11-09T14:00:05.000Z'), 1800)).toMatchObject({ late: false, closesAt: at('2026-11-09T14:30:00.000Z') });
    expect(LATE_ENTRY_MS).toBe(50_000);
  });
});
