import { FALLBACK_PROVIDER, PRIMARY_PROVIDER, type FeedProvider, type Tick } from './types.js';

export interface SourceSelectorOptions {
  /** Switch a symbol to the fallback after this long without a primary tick. */
  failoverMs: number;
  /** Switch back once the primary has ticked without interruption for this long. */
  recoverStableMs: number;
  /** A primary gap longer than this restarts the stability clock. */
  gapMs: number;
}

export interface SourceSwitch {
  symbol: string;
  from: FeedProvider;
  to: FeedProvider;
  reason: string;
}

interface SymbolState {
  hasFallback: boolean;
  usingFallback: boolean;
  /** When tracking started; failover is measured from here until the first primary tick. */
  since: number;
  lastPrimaryMs: number | null;
  /** Start of the current uninterrupted run of primary ticks. */
  primaryRunStart: number | null;
}

/**
 * Decides, per symbol, which provider's ticks become prices. Ticks from the
 * provider not in use are dropped, so the two feeds are never mixed.
 */
export class SourceSelector {
  private readonly states = new Map<string, SymbolState>();

  constructor(
    private readonly opts: SourceSelectorOptions,
    symbols: ReadonlyArray<{ symbol: string; hasFallback: boolean }>,
    now: number,
  ) {
    this.setSymbols(symbols, now);
  }

  /** Keeps state for symbols that remain, adds new ones, drops removed ones. */
  setSymbols(symbols: ReadonlyArray<{ symbol: string; hasFallback: boolean }>, now: number): void {
    const keep = new Set(symbols.map((s) => s.symbol));
    for (const sym of this.states.keys()) if (!keep.has(sym)) this.states.delete(sym);
    for (const s of symbols) {
      const existing = this.states.get(s.symbol);
      if (existing) {
        existing.hasFallback = s.hasFallback;
        if (!s.hasFallback) existing.usingFallback = false;
        continue;
      }
      this.states.set(s.symbol, {
        hasFallback: s.hasFallback,
        usingFallback: false,
        since: now,
        lastPrimaryMs: null,
        primaryRunStart: null,
      });
    }
  }

  /** Records the tick and returns true when it should become the symbol's price. */
  accept(tick: Tick): boolean {
    const s = this.states.get(tick.symbol);
    if (!s) return false;
    if (tick.provider === PRIMARY_PROVIDER) {
      if (s.lastPrimaryMs === null || tick.recvMs - s.lastPrimaryMs > this.opts.gapMs) {
        s.primaryRunStart = tick.recvMs;
      }
      s.lastPrimaryMs = tick.recvMs;
      return !s.usingFallback;
    }
    return s.usingFallback;
  }

  /** Call periodically; returns the switches made at `now`. */
  evaluate(now: number): SourceSwitch[] {
    const switches: SourceSwitch[] = [];
    for (const [symbol, s] of this.states) {
      if (!s.hasFallback) continue;
      if (!s.usingFallback) {
        const silentMs = now - (s.lastPrimaryMs ?? s.since);
        if (silentMs > this.opts.failoverMs) {
          s.usingFallback = true;
          switches.push({
            symbol,
            from: PRIMARY_PROVIDER,
            to: FALLBACK_PROVIDER,
            reason: `no ${PRIMARY_PROVIDER} tick for ${silentMs} ms`,
          });
        }
        continue;
      }
      const primaryAlive = s.lastPrimaryMs !== null && now - s.lastPrimaryMs <= this.opts.gapMs;
      if (primaryAlive && s.primaryRunStart !== null && now - s.primaryRunStart >= this.opts.recoverStableMs) {
        s.usingFallback = false;
        switches.push({
          symbol,
          from: FALLBACK_PROVIDER,
          to: PRIMARY_PROVIDER,
          reason: `${PRIMARY_PROVIDER} stable for ${now - s.primaryRunStart} ms`,
        });
      }
    }
    return switches;
  }

  sourceOf(symbol: string): FeedProvider | undefined {
    const s = this.states.get(symbol);
    if (!s) return undefined;
    return s.usingFallback ? FALLBACK_PROVIDER : PRIMARY_PROVIDER;
  }

  symbols(): IterableIterator<string> {
    return this.states.keys();
  }
}
