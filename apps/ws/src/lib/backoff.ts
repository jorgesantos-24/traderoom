export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns [0, 1). Injected by tests. */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": the delay for attempt n is a random
 * value in [exp/2, exp], where exp = min(max, base * 2^n), never below base.
 * With base 1 s and max 30 s: 1 s, 1–2 s, 2–4 s, ... up to 15–30 s.
 */
export class Backoff {
  private attempt = 0;
  private readonly random: () => number;

  constructor(private readonly opts: BackoffOptions) {
    this.random = opts.random ?? Math.random;
  }

  next(): number {
    const exp = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** this.attempt);
    // Cap the exponent so 2^n never overflows on a very long outage.
    this.attempt = Math.min(this.attempt + 1, 30);
    const delay = exp / 2 + (exp / 2) * this.random();
    return Math.round(Math.min(this.opts.maxMs, Math.max(this.opts.baseMs, delay)));
  }

  reset(): void {
    this.attempt = 0;
  }

  /** Failed attempts since the last reset. */
  get attempts(): number {
    return this.attempt;
  }
}
