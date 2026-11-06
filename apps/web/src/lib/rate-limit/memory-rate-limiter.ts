import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";

/** Hard cap on tracked keys so a flood of distinct keys cannot grow memory without bound. */
const DEFAULT_MAX_KEYS = 10_000;

interface Bucket {
  /** Timestamps (ms) of counted requests inside the window, oldest first. */
  hits: number[];
  windowMs: number;
}

/**
 * Sliding-window-log limiter held in process memory.
 *
 * SINGLE INSTANCE ONLY: each server process counts on its own, so N instances allow N times the
 * limit and a restart resets every counter. That is acceptable as a first line of defence; a
 * Postgres-backed `RateLimiter` is the planned follow-up (it needs a table, so a schema ticket).
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    return Promise.resolve(this.consumeSync(key, rule));
  }

  /** Number of tracked buckets (for tests and diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  private consumeSync(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.now();
    const bucket = this.touch(`${rule.name}:${key}`, rule.windowMs);

    const windowStart = now - rule.windowMs;
    while (bucket.hits.length > 0 && (bucket.hits[0] ?? 0) <= windowStart) bucket.hits.shift();

    const oldest = bucket.hits[0] ?? now;
    const resetSeconds = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));

    if (bucket.hits.length >= rule.limit) {
      // Blocked requests are not counted, so retrying does not extend the block.
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        resetSeconds,
        retryAfterSeconds: resetSeconds,
      };
    }

    bucket.hits.push(now);
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - bucket.hits.length,
      resetSeconds,
      retryAfterSeconds: 0,
    };
  }

  /** Returns the bucket (moved to the newest position) and evicts old buckets over the cap. */
  private touch(bucketKey: string, windowMs: number): Bucket {
    const bucket = this.buckets.get(bucketKey) ?? { hits: [], windowMs };
    bucket.windowMs = windowMs;
    // Re-insert so Map iteration order runs least- to most-recently used.
    this.buckets.delete(bucketKey);
    this.buckets.set(bucketKey, bucket);
    if (this.buckets.size > this.maxKeys) this.evict(bucketKey);
    return bucket;
  }

  /** Never evicts `keep`, the bucket being used right now (it has no hits recorded yet). */
  private evict(keep: string): void {
    const now = this.now();
    // First drop buckets whose window has fully passed, then the least recently used.
    for (const [bucketKey, bucket] of this.buckets) {
      if (bucketKey === keep) continue;
      const newest = bucket.hits.at(-1);
      if (newest === undefined || newest <= now - bucket.windowMs) this.buckets.delete(bucketKey);
    }
    for (const bucketKey of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      if (bucketKey !== keep) this.buckets.delete(bucketKey);
    }
  }
}
