import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryRateLimiter,
  getClientIp,
  limitAction,
  matchRouteRateLimit,
  rateLimitHeaders,
  setRateLimiter,
  tooManyRequestsResponse,
  type RateLimitRule,
} from ".";

afterEach(() => {
  setRateLimiter(undefined);
});

describe("getClientIp", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("uses the first x-forwarded-for hop", () => {
    expect(getClientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip, then to a shared 'unknown' bucket", () => {
    expect(getClientIp(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(getClientIp(headers({}))).toBe("unknown");
  });

  it("ignores values that are not IP literals", () => {
    expect(getClientIp(headers({ "x-forwarded-for": "<script>alert(1)</script>" }))).toBe(
      "unknown",
    );
    expect(getClientIp(headers({ "x-forwarded-for": "a".repeat(200) }))).toBe("unknown");
  });
});

describe("matchRouteRateLimit", () => {
  it("limits sign-in submissions, the auth callback and /app mutations", () => {
    expect(matchRouteRateLimit("POST", "/sign-in")).toMatchObject({ scope: "ip" });
    expect(matchRouteRateLimit("GET", "/auth/callback")).toMatchObject({ scope: "ip" });
    expect(matchRouteRateLimit("POST", "/app")).toMatchObject({ scope: "user" });
    expect(matchRouteRateLimit("POST", "/app/agents")).toMatchObject({ scope: "user" });
  });

  it("does not limit page views or unrelated routes", () => {
    expect(matchRouteRateLimit("GET", "/sign-in")).toBeUndefined();
    expect(matchRouteRateLimit("GET", "/app")).toBeUndefined();
    expect(matchRouteRateLimit("POST", "/application")).toBeUndefined();
    expect(matchRouteRateLimit("GET", "/")).toBeUndefined();
  });
});

describe("rate limit responses", () => {
  const rule: RateLimitRule = { name: "r", limit: 5, windowMs: 60_000 };

  it("adds RateLimit headers, and Retry-After only when blocked", () => {
    const allowed = rateLimitHeaders(rule, {
      allowed: true,
      limit: 5,
      remaining: 4,
      resetSeconds: 60,
      retryAfterSeconds: 0,
    });
    expect(allowed).toMatchObject({
      "RateLimit-Limit": "5",
      "RateLimit-Remaining": "4",
      "RateLimit-Reset": "60",
      "RateLimit-Policy": "5;w=60",
    });
    expect(allowed).not.toHaveProperty("Retry-After");
  });

  it("builds a 429 with Retry-After and a JSON body", async () => {
    const response = tooManyRequestsResponse(rule, {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetSeconds: 42,
      retryAfterSeconds: 42,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 42 });
  });
});

describe("limitAction", () => {
  const rule: RateLimitRule = { name: "action", limit: 2, windowMs: 60_000 };

  it("allows within budget, then returns a friendly message and retry time", async () => {
    setRateLimiter(new MemoryRateLimiter());

    expect(await limitAction("a@example.com", rule)).toEqual({ allowed: true });
    expect(await limitAction("A@Example.com", rule)).toEqual({ allowed: true });
    const blocked = await limitAction("a@example.com", rule);

    expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    if (!blocked.allowed) expect(blocked.message).toMatch(/^Too many attempts\. Try again in/);
  });

  it("fails open when the limiter throws", async () => {
    setRateLimiter({ consume: () => Promise.reject(new Error("store down")) });

    expect(await limitAction("a@example.com", rule)).toEqual({ allowed: true });
  });
});
