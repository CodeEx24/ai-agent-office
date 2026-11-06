import type { RateLimitResult, RateLimitRule } from "./types";

/**
 * Standard limit headers (IETF draft-ietf-httpapi-ratelimit-headers) on every limited response,
 * plus `Retry-After` (seconds) when blocked.
 */
export function rateLimitHeaders(
  rule: RateLimitRule,
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetSeconds),
    "RateLimit-Policy": `${String(rule.limit)};w=${String(Math.round(rule.windowMs / 1000))}`,
  };
  if (!result.allowed) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

/** The 429 body and headers for a blocked request. */
export function tooManyRequestsResponse(rule: RateLimitRule, result: RateLimitResult): Response {
  return Response.json(
    {
      error: "rate_limited",
      message: `Too many requests. Try again in ${String(result.retryAfterSeconds)} seconds.`,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: 429,
      headers: { ...rateLimitHeaders(rule, result), "Cache-Control": "no-store" },
    },
  );
}
