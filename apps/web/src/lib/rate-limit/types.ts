export interface RateLimitRule {
  /** Short stable name, part of the bucket key and of the policy header. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the oldest counted request leaves the window. */
  resetSeconds: number;
  /** Seconds to wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Storage-agnostic limiter. Async so a shared store (Postgres, later) can replace the in-memory
 * one without touching callers. `key` identifies who is limited (e.g. `ip:1.2.3.4`); the limiter
 * adds the rule name, so one identity has an independent bucket per rule.
 */
export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
}
