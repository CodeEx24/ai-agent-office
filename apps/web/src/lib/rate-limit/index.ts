import { MemoryRateLimiter } from "./memory-rate-limiter";
import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";

export { getClientIp } from "./client-ip";
export { rateLimitHeaders, tooManyRequestsResponse } from "./headers";
export { MemoryRateLimiter } from "./memory-rate-limiter";
export { RATE_LIMIT_RULES, matchRouteRateLimit } from "./rules";
export type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";

const GLOBAL_KEY = Symbol.for("ago.rateLimiter");
type GlobalWithLimiter = typeof globalThis & { [GLOBAL_KEY]?: RateLimiter };

/**
 * The process-wide limiter. Held on globalThis because Next bundles the proxy and the server
 * code separately; a module-level variable would give each its own counters.
 */
export function getRateLimiter(): RateLimiter {
  const holder = globalThis as GlobalWithLimiter;
  holder[GLOBAL_KEY] ??= new MemoryRateLimiter();
  return holder[GLOBAL_KEY];
}

/** Replaces the process-wide limiter (tests, or a shared store later). */
export function setRateLimiter(limiter: RateLimiter | undefined): void {
  (globalThis as GlobalWithLimiter)[GLOBAL_KEY] = limiter;
}

export type ActionRateLimit =
  { allowed: true } | { allowed: false; message: string; retryAfterSeconds: number };

function formatWait(seconds: number): string {
  if (seconds < 90) return `${String(seconds)} seconds`;
  return `${String(Math.ceil(seconds / 60))} minutes`;
}

/**
 * Per-identity limit for a server action. Actions cannot set an HTTP status, so a blocked call
 * gets a message to show instead. A limiter fault fails open: the proxy's HTTP limits and
 * Supabase's own limits still apply, and locking everyone out of sign-in on a fault is worse.
 */
export async function limitAction(identity: string, rule: RateLimitRule): Promise<ActionRateLimit> {
  let result: RateLimitResult;
  try {
    result = await getRateLimiter().consume(identity.toLowerCase(), rule);
  } catch {
    return { allowed: true };
  }
  if (result.allowed) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: result.retryAfterSeconds,
    message: `Too many attempts. Try again in ${formatWait(result.retryAfterSeconds)}.`,
  };
}
