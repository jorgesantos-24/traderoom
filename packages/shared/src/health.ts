export interface HealthCheck {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface FeedHealthCheck extends HealthCheck {
  /** Age of the newest tick in ms, or null if no tick was ever recorded. */
  ageMs: number | null;
}

export interface HealthResponse {
  status: 'ok' | 'fail';
  checks: {
    postgres: HealthCheck;
    redis: HealthCheck;
    feed: FeedHealthCheck;
  };
}
