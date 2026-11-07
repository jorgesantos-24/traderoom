export interface StaleChange {
  symbol: string;
  on: boolean;
}

interface Entry {
  lastMs: number | null;
  stale: boolean;
}

/**
 * Staleness per symbol, judged on local receive time of accepted ticks.
 * Every symbol starts stale (no price yet) without emitting a change; it
 * recovers on its first tick and goes stale again after `staleMs` of silence.
 */
export class StaleTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly staleMs: number,
    symbols: Iterable<string>,
  ) {
    this.setSymbols(symbols);
  }

  setSymbols(symbols: Iterable<string>): void {
    const keep = new Set(symbols);
    for (const sym of this.entries.keys()) if (!keep.has(sym)) this.entries.delete(sym);
    for (const sym of keep) if (!this.entries.has(sym)) this.entries.set(sym, { lastMs: null, stale: true });
  }

  /** Records an accepted tick; returns the change if the symbol just recovered. */
  seen(symbol: string, recvMs: number): StaleChange | null {
    const e = this.entries.get(symbol);
    if (!e) return null;
    if (e.lastMs === null || recvMs > e.lastMs) e.lastMs = recvMs;
    if (!e.stale) return null;
    e.stale = false;
    return { symbol, on: false };
  }

  /** Call periodically; returns symbols that just went stale. */
  evaluate(now: number): StaleChange[] {
    const changes: StaleChange[] = [];
    for (const [symbol, e] of this.entries) {
      if (e.stale || e.lastMs === null) continue;
      if (now - e.lastMs > this.staleMs) {
        e.stale = true;
        changes.push({ symbol, on: true });
      }
    }
    return changes;
  }

  isStale(symbol: string): boolean {
    return this.entries.get(symbol)?.stale ?? true;
  }

  /** ms since the last accepted tick, or null if none yet. */
  ageMs(symbol: string, now: number): number | null {
    const last = this.entries.get(symbol)?.lastMs;
    return last === null || last === undefined ? null : Math.max(0, now - last);
  }
}
