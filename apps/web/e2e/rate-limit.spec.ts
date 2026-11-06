import { randomInt } from "node:crypto";

import { expect, test } from "./fixtures";

// AGO-66 AC2: rate limits return 429 with retry hints. Each test uses its own x-forwarded-for
// address, so it fills only its own bucket and cannot starve the other specs that share 127.0.0.1.
// Budgets come from src/lib/rate-limit/rules.ts: 60 sign-in POSTs/min, 30 callbacks/min per IP.

function uniqueIp(): string {
  return `198.51.100.${String(randomInt(1, 254))}, 10.0.0.${String(randomInt(1, 254))}`;
}

test.describe("AGO-66 AC2: rate limits", () => {
  test("repeated sign-in submissions from one IP get 429 with Retry-After and RateLimit headers", async ({
    request,
  }) => {
    const headers = { "x-forwarded-for": uniqueIp(), "next-action": "00".repeat(20) };
    const post = () =>
      request.post("/sign-in", { headers, data: "[]", failOnStatusCode: false, maxRedirects: 0 });

    // The first 60 reach the app (an unknown action id is not a 429); the 61st is limited.
    for (let attempt = 1; attempt <= 60; attempt++) {
      expect((await post()).status(), `attempt ${String(attempt)}`).not.toBe(429);
    }
    const blocked = await post();

    expect(blocked.status()).toBe(429);
    const responseHeaders = blocked.headers();
    expect(Number(responseHeaders["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(responseHeaders["retry-after"])).toBeLessThanOrEqual(60);
    expect(responseHeaders["ratelimit-limit"]).toBe("60");
    expect(responseHeaders["ratelimit-remaining"]).toBe("0");
    expect(Number(responseHeaders["ratelimit-reset"])).toBeGreaterThanOrEqual(1);
    expect(responseHeaders["ratelimit-policy"]).toBe("60;w=60");
    expect(responseHeaders["cache-control"]).toBe("no-store");
    expect(await blocked.json()).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: Number(responseHeaders["retry-after"]),
    });
    // The 429 still carries the security headers.
    expect(responseHeaders["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("the limit is per IP: another address is unaffected", async ({ request }) => {
    const noisy = { "x-forwarded-for": uniqueIp() };
    for (let attempt = 0; attempt < 30; attempt++) {
      await request.get("/auth/callback?code=bogus", { headers: noisy, maxRedirects: 0 });
    }

    const blocked = await request.get("/auth/callback?code=bogus", {
      headers: noisy,
      maxRedirects: 0,
    });
    const other = await request.get("/auth/callback?code=bogus", {
      headers: { "x-forwarded-for": uniqueIp() },
      maxRedirects: 0,
    });

    expect(blocked.status()).toBe(429);
    expect(blocked.headers()["retry-after"]).toBeTruthy();
    // Not limited: the normal redirect back to sign-in for a bad code.
    expect(other.status()).toBe(307);
  });

  test("GET /api/capabilities is rate limited: 429 with Retry-After once over budget (AGO-201)", async ({
    request,
  }) => {
    const headers = { "x-forwarded-for": uniqueIp() };
    const get = () => request.get("/api/capabilities", { headers, failOnStatusCode: false });

    // Signed out, the budget is counted per IP: 120 reads reach the route (a 401, not a 429).
    for (let attempt = 1; attempt <= 120; attempt++) {
      expect((await get()).status(), `attempt ${String(attempt)}`).not.toBe(429);
    }
    const blocked = await get();

    expect(blocked.status()).toBe(429);
    expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers()["ratelimit-limit"]).toBe("120");
  });

  test("page views are not rate limited", async ({ request }) => {
    const headers = { "x-forwarded-for": uniqueIp() };
    for (let attempt = 0; attempt < 70; attempt++) {
      expect((await request.get("/sign-in", { headers })).status()).toBe(200);
    }
  });
});
