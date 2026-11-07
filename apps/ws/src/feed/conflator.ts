import type { StaleFrame, TickFrame } from '@traderoom/shared';
import type { Tick } from './types.js';

/** Process-wide frame sequence; shared by tick frames and (later) per-connection snapshots. */
export class SeqCounter {
  private n = 0;

  next(): number {
    this.n += 1;
    return this.n;
  }
}

export interface PublishedPrice {
  tick: Tick;
  /** Pre-serialized `tick` frame: the same Buffer goes to every subscriber of the symbol. */
  frame: Buffer;
}

/**
 * Keeps only the newest tick per symbol inside a window. `flush()` is called
 * once per window (200 ms) and returns one frame per symbol that changed.
 */
export class Conflator {
  private pending = new Map<string, Tick>();

  constructor(private readonly seq: SeqCounter) {}

  push(tick: Tick): void {
    this.pending.set(tick.symbol, tick);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  flush(): PublishedPrice[] {
    if (this.pending.size === 0) return [];
    const batch = this.pending;
    this.pending = new Map();
    const out: PublishedPrice[] = [];
    for (const tick of batch.values()) {
      const frame: TickFrame = {
        t: 'tick',
        seq: this.seq.next(),
        data: [{ s: tick.symbol, p: tick.value, ts: tick.ts }],
      };
      out.push({ tick, frame: Buffer.from(JSON.stringify(frame)) });
    }
    return out;
  }
}

export function staleFrame(symbol: string, on: boolean): Buffer {
  const frame: StaleFrame = { t: 'stale', s: symbol, on };
  return Buffer.from(JSON.stringify(frame));
}
