import { describe, expect, it } from "vitest";

import { MemoryRateLimiter } from "./memory-rate-limiter";
import type { RateLimitRule } from "./types";

const RULE: RateLimitRule = { name: "test", limit: 3, windowMs: 10_000 };

function createLimiter(maxKeys?: number) {
  let now = 1_000_000;
  const limiter = new MemoryRateLimiter(() => now, maxKeys);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MemoryRateLimiter", () => {
  it("allows up to the limit and reports the remaining budget", async () => {
    const { limiter } = createLimiter();

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await limiter.consume("ip:1", RULE));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
  });

  it("blocks the request over the limit with a retry hint", async () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < 3; i++) await limiter.consume("ip:1", RULE);
    advance(4_000);

    const blocked = await limiter.consume("ip:1", RULE);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // The oldest hit leaves the window 10s after it was made, i.e. 6s from now.
    expect(blocked.retryAfterSeconds).toBe(6);
    expect(blocked.limit).toBe(3);
  });

  it("slides: capacity returns as old hits leave the window", async () => {
    const { limiter, advance } = createLimiter();
    await limiter.consume("ip:1", RULE);
    advance(6_000);
    await limiter.consume("ip:1", RULE);
    await limiter.consume("ip:1", RULE);
    expect((await limiter.consume("ip:1", RULE)).allowed).toBe(false);

    advance(4_001); // the first hit is now 10s old

    expect((await limiter.consume("ip:1", RULE)).allowed).toBe(true);
    expect((await limiter.consume("ip:1", RULE)).allowed).toBe(false);
  });

  it("does not count blocked requests, so retrying cannot extend the block", async () => {
    const { limiter, advance } = createLimiter();
    for (let i = 0; i < 3; i++) await limiter.consume("ip:1", RULE);
    for (let i = 0; i < 20; i++) await limiter.consume("ip:1", RULE);

    advance(10_001);

    expect((await limiter.consume("ip:1", RULE)).allowed).toBe(true);
  });

  it("keeps separate buckets per key and per rule", async () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < 3; i++) await limiter.consume("ip:1", RULE);

    expect((await limiter.consume("ip:2", RULE)).allowed).toBe(true);
    expect((await limiter.consume("ip:1", { ...RULE, name: "other" })).allowed).toBe(true);
    expect((await limiter.consume("ip:1", RULE)).allowed).toBe(false);
  });

  it("bounds memory: tracked keys never exceed the cap", async () => {
    const { limiter } = createLimiter(5);

    for (let i = 0; i < 50; i++) await limiter.consume(`ip:${String(i)}`, RULE);

    expect(limiter.size).toBeLessThanOrEqual(5);
  });

  it("drops expired buckets before live ones when over the cap", async () => {
    const { limiter, advance } = createLimiter(2);
    await limiter.consume("ip:old", RULE);
    advance(RULE.windowMs + 1);
    await limiter.consume("ip:live", RULE);
    for (let i = 0; i < 3; i++) await limiter.consume("ip:live2", RULE);

    // ip:live2 is still blocked: it was not evicted in favour of the expired bucket.
    expect((await limiter.consume("ip:live2", RULE)).allowed).toBe(false);
  });
});
