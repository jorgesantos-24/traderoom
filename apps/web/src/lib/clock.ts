/**
 * Estimates the offset between the server clock and this device's clock, so countdowns stay
 * right even when the local clock is off by seconds. Each sample is a server timestamp taken
 * somewhere between `sentAt` and `receivedAt` (local ms); the sample with the smallest
 * uncertainty wins, and old samples expire so a changed local clock is picked up.
 */
export class ServerClock {
  private best: { offset: number; error: number; at: number } | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxSampleAgeMs = 10 * 60_000,
  ) {}

  /** `precisionMs` is how coarse the server timestamp is (1000 for the HTTP Date header). */
  observe(serverMs: number, sentAt: number, receivedAt: number, precisionMs = 0): void {
    if (!Number.isFinite(serverMs) || receivedAt < sentAt) return;
    const mid = (sentAt + receivedAt) / 2;
    // A Date header truncates to the second, so the real instant is up to precisionMs later.
    const offset = serverMs + precisionMs / 2 - mid;
    const error = (receivedAt - sentAt) / 2 + precisionMs / 2;
    const at = this.now();
    const stale = this.best !== null && at - this.best.at > this.maxSampleAgeMs;
    if (this.best === null || stale || error <= this.best.error) this.best = { offset, error, at };
  }

  /** Server ms minus local ms; 0 until a sample arrives. */
  get offsetMs(): number {
    return this.best?.offset ?? 0;
  }

  serverNow(): number {
    return this.now() + this.offsetMs;
  }
}

export const serverClock = new ServerClock();

/** Parses the API's ISO timestamps (µs precision) to epoch ms, independent of engine quirks. */
export function parseServerTime(iso: string): number {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) return Date.parse(iso);
  const ms = (m[2] ?? '').slice(0, 3).padEnd(3, '0');
  return Date.parse(`${m[1]}.${ms}${m[3]}`);
}
