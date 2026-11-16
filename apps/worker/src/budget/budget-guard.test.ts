import { describe, expect, it, vi } from "vitest";

import { createBudgetGuard } from "./budget-guard.js";
import { createFakeBudgetStore } from "./budget-store.test-helpers.js";

import type { BudgetCallRequest } from "./budget-guard.js";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const AT = new Date("2026-11-14T10:00:00Z");

const call = (over: Partial<BudgetCallRequest> = {}): BudgetCallRequest => ({
  workspaceId: WS,
  agentId: AGENT,
  model: "claude-haiku-5-5",
  inputCharacters: 3_000,
  maxOutputTokens: 1_000,
  ...over,
});

function setup(options: Parameters<typeof createFakeBudgetStore>[0] = {}) {
  const store = createFakeBudgetStore(options);
  const onStoreError = vi.fn();
  const guard = createBudgetGuard({ store, onStoreError, now: () => AT });
  return { store, guard, onStoreError };
}

describe("budget guard: reserve", () => {
  it("holds the worst-case cost before the call", async () => {
    const { guard, store } = setup();
    const decision = await guard.reserve(call());
    // 1000 prompt tokens x 100 + 1000 output tokens x 500 = 600,000 micro-cents -> 1 cent
    expect(decision).toMatchObject({ allowed: true, estimateCents: 1 });
    expect(store.dayUsed()).toBe(1);
    expect(store.monthUsed()).toBe(1);
  });

  it("refuses when the agent's daily budget would be exceeded, holding nothing", async () => {
    const { guard, store } = setup({ dailyBudgetCents: 10, dayUsedCents: 10 });
    const decision = await guard.reserve(call());
    expect(decision).toEqual({
      allowed: false,
      scope: "agent_daily",
      reason: "agent_daily_limit_would_be_exceeded",
      limit: 10,
      used: 10,
      estimateCents: 1,
    });
    expect(store.dayUsed()).toBe(10);
  });

  it("refuses when the workspace's monthly budget would be exceeded", async () => {
    const { guard } = setup({ monthlyBudgetCents: 50, monthUsedCents: 50 });
    expect(await guard.reserve(call())).toMatchObject({
      allowed: false,
      scope: "workspace_monthly",
      reason: "workspace_monthly_limit_would_be_exceeded",
      limit: 50,
      used: 50,
    });
  });

  it("uses the platform default monthly cap when the workspace set none", async () => {
    const { guard } = setup({ monthUsedCents: 100_000 });
    expect(await guard.reserve(call())).toMatchObject({
      allowed: false,
      scope: "workspace_monthly",
      limit: 100_000,
    });
  });

  it("DENIES a model that has no price, and never asks the ledger", async () => {
    const { guard, store } = setup();
    expect(await guard.reserve(call({ model: "claude-unknown-9" }))).toEqual({
      allowed: false,
      scope: "pricing",
      reason: "model_not_priced",
      limit: 0,
      used: 0,
    });
    expect(store.calls.reserve).toBe(0);
  });

  it("DENIES a provider that does not say which model it is", async () => {
    const { guard } = setup();
    expect(await guard.reserve(call({ model: undefined }))).toMatchObject({
      allowed: false,
      reason: "model_not_priced",
    });
  });

  it("DENIES when the ledger fails, and reports the failure", async () => {
    const { guard, store, onStoreError } = setup();
    store.failNext("reserve");
    expect(await guard.reserve(call())).toMatchObject({
      allowed: false,
      scope: "ledger",
      reason: "budget_check_failed",
    });
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it("still denies when the error reporter itself throws", async () => {
    const store = createFakeBudgetStore();
    store.failNext("reserve");
    const guard = createBudgetGuard({
      store,
      onStoreError: () => {
        throw new Error("reporter broke");
      },
    });
    expect(await guard.reserve(call())).toMatchObject({
      allowed: false,
      reason: "budget_check_failed",
    });
  });

  it("reserves more for a bigger prompt and a bigger output allowance", async () => {
    const { guard } = setup({ dailyBudgetCents: 5_000 });
    const small = await guard.reserve(call({ inputCharacters: 3, maxOutputTokens: 1 }));
    const big = await guard.reserve(call({ inputCharacters: 3_000_000, maxOutputTokens: 200_000 }));
    expect(small).toMatchObject({ allowed: true, estimateCents: 1 });
    // 1,000,000 x 100 + 200,000 x 500 = 200,000,000 micro-cents -> 200 cents
    expect(big).toMatchObject({ allowed: true, estimateCents: 200 });
  });
});

describe("budget guard: settle and release", () => {
  async function reserved(options: Parameters<typeof createFakeBudgetStore>[0] = {}) {
    const ctx = setup(options);
    // 50,000 prompt tokens x 100 + 10,000 output tokens x 500 = 10,000,000 micro-cents -> 10 cents
    const decision = await ctx.guard.reserve(
      call({ inputCharacters: 150_000, maxOutputTokens: 10_000 }),
    );
    if (!decision.allowed) throw new Error("expected the reserve to be allowed");
    expect(decision.estimateCents).toBe(10);
    return { ...ctx, reservation: decision.reservation };
  }

  it("settling a LOWER real cost releases the difference and adds the tokens", async () => {
    const { guard, store, reservation } = await reserved();
    const settlement = await guard.settle(reservation, "claude-haiku-5-5", {
      inputTokens: 1_000,
      outputTokens: 500,
    });
    // 1,000 x 100 + 500 x 500 = 350,000 micro-cents -> 1 cent
    expect(settlement).toEqual({ costCents: 1, overran: false, ledgerFailed: false });
    expect(store.dayUsed()).toBe(1);
    expect(store.monthUsed()).toBe(1);
    expect(store.tokensUsed()).toBe(1_500);
  });

  it("settling a HIGHER real cost records the overrun and says so", async () => {
    const { guard, store, reservation } = await reserved();
    const settlement = await guard.settle(reservation, "claude-haiku-5-5", {
      inputTokens: 500_000,
      outputTokens: 100_000,
    });
    // 500,000 x 100 + 100,000 x 500 = 100,000,000 micro-cents -> 100 cents
    expect(settlement).toEqual({ costCents: 100, overran: true, ledgerFailed: false });
    expect(store.dayUsed()).toBe(100);
    expect(store.monthUsed()).toBe(100);
  });

  it("a settlement equal to the reservation is not an overrun", async () => {
    const { guard, reservation } = await reserved();
    const settlement = await guard.settle(reservation, "claude-haiku-5-5", {
      inputTokens: 50_000,
      outputTokens: 10_000,
    });
    expect(settlement).toMatchObject({ costCents: 10, overran: false });
  });

  it("reports a ledger that cannot record the real cost", async () => {
    const { guard, store, onStoreError, reservation } = await reserved();
    store.failNext("settle");
    const settlement = await guard.settle(reservation, "claude-haiku-5-5", {
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(settlement.ledgerFailed).toBe(true);
    expect(settlement.costCents).toBe(1);
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it("charges the whole reservation when the price vanished between reserve and settle", async () => {
    const { guard, store, reservation } = await reserved();
    const settlement = await guard.settle(reservation, "claude-unknown-9", {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(settlement.costCents).toBe(10);
    expect(store.dayUsed()).toBe(10);
  });

  it("release gives the held cents back", async () => {
    const { guard, store, reservation } = await reserved();
    await guard.release(reservation);
    expect(store.dayUsed()).toBe(0);
    expect(store.monthUsed()).toBe(0);
  });

  it("a failing release leaves the cents held (over-count, never under) and does not throw", async () => {
    const { guard, store, onStoreError, reservation } = await reserved();
    store.failNext("release");
    await expect(guard.release(reservation)).resolves.toBeUndefined();
    expect(store.dayUsed()).toBe(10);
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });
});
