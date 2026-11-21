// AGO-81 round 5, independent tests of "give then spend": a handoff task has its OWN spend limit, its narrowed budget
// minus what it already gave to child handoffs. No database: the guard (before each model call) and the policy hook
// (before each tool call) are driven with a plain store stub, so the grid below is cheap. The expected answer is derived
// from the rule itself (spent + given must stay below the grant), never from the code under test.
import { describe, expect, it, vi } from "vitest";

import {
  HANDOFF_BUDGET_EXHAUSTED,
  createHandoffPolicyHook,
} from "../policy/handoff-policy-hook.js";

import { withHandoffBudget } from "./handoff-budget-guard.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
import type { BudgetDecision, BudgetGuard } from "../budget/budget-guard.js";
import type { PolicyInputs } from "../policy/pg-policy-source.js";
import type { HandoffRecord, HandoffStore } from "./handoff-store.js";

const WS = "11111111-1111-4111-8111-111111111111";
const MODEL = "claude-haiku-5-5"; // 500 cents per million output tokens: 2000 output tokens cost exactly 1 cent

const record = (budgetCents: number): HandoffRecord => ({
  taskId: "7a5c0000-0000-4000-8000-000000000001",
  workspaceId: WS,
  fromAgentId: "a",
  senderRunId: "run-a",
  toAgentId: "b",
  requesterMemberId: "m",
  path: ["a", "b"],
  depth: 1,
  narrowed: {
    capabilities: [{ capabilityKey: "vault.read", tier: 0, mode: "automatic" }],
    budgetCents,
    dataScope: [],
  },
  title: "t",
  description: "",
  acceptedByRunId: "run-b",
});

type Store = Pick<HandoffStore, "findByRun" | "spentCentsOnTask" | "allocatedCentsOnRun">;
const stubStore = (budgetCents: number, spent: number, given: number): Store => ({
  findByRun: () => Promise.resolve(record(budgetCents)),
  spentCentsOnTask: () => Promise.resolve(spent),
  allocatedCentsOnRun: () => Promise.resolve(given),
});

const allowed: BudgetDecision = {
  allowed: true,
  reservation: {
    workspaceId: WS,
    agentId: "b",
    cents: 1,
    dayStart: "2026-11-20",
    monthStart: "2026-11-01",
  },
  estimateCents: 1,
};
const innerGuard = () => {
  const reserve = vi.fn((): Promise<BudgetDecision> => Promise.resolve(allowed));
  const guard: BudgetGuard = {
    reserve,
    settle: () => Promise.resolve({ costCents: 1, overran: false, ledgerFailed: false }),
    release: () => Promise.resolve(),
    chargeReserved: () => Promise.resolve(),
  };
  return { guard, reserve };
};
/** A call whose worst case is exactly `cents` (no input, 2000 output tokens per cent). */
const callOf = (cents: number) => ({
  workspaceId: WS,
  agentId: "b",
  runId: "run-b",
  model: MODEL,
  inputCharacters: 0,
  maxOutputTokens: cents * 2_000,
});

const context: PolicyContext = {
  workspaceId: WS,
  runId: "run-b",
  agentId: "b",
  step: 1,
  signal: new AbortController().signal,
};
const toolCall: PolicyToolCall = {
  callId: "c1",
  toolName: "read_note",
  input: {},
  tier: 0,
  capabilityKey: "vault.read",
  isRegistered: true,
};
const inputs: PolicyInputs = {
  agent: {
    mode: "strict",
    grants: [{ capabilityKey: "vault.read", tier: 0, mode: "automatic", isEnabled: true }],
  },
  policies: [],
};
const hookFor = (store: Store) =>
  createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(inputs) } });

async function guardAllows(store: Store, cents: number): Promise<boolean> {
  const { guard } = innerGuard();
  return (await withHandoffBudget(guard, store).reserve(callOf(cents))).allowed;
}
async function hookAllows(store: Store): Promise<boolean> {
  return (await hookFor(store).check(toolCall, context)).decision === "allow";
}

describe("AC2: give-then-spend, the own limit is what the task did not give away", () => {
  it("guard and hook agree on every (spent, given) pair of a 10 cent grant and both follow spent + given < grant", async () => {
    const GRANT = 10;
    const disagreements: string[] = [];
    for (let spent = 0; spent <= GRANT + 1; spent += 1) {
      for (let given = 0; given <= GRANT + 1; given += 1) {
        const store = stubStore(GRANT, spent, given);
        const expected = spent + given < GRANT; // one more cent still fits
        const byGuard = await guardAllows(store, 1);
        const byHook = await hookAllows(store);
        if (byGuard !== expected || byHook !== expected) {
          disagreements.push(JSON.stringify({ spent, given, byGuard, byHook, expected }));
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("the guard refuses a call one cent over the boundary and allows one that lands exactly on it", async () => {
    const store = stubStore(100, 20, 40); // own limit 60, 20 spent: 40 cents left
    expect(await guardAllows(store, 40)).toBe(true);
    expect(await guardAllows(store, 41)).toBe(false);
  });

  it("the guard reports the reduced limit, not the narrowed budget, when it refuses", async () => {
    const { guard, reserve } = innerGuard();
    const decision = await withHandoffBudget(guard, stubStore(100, 20, 40)).reserve(callOf(41));
    expect(decision).toMatchObject({
      allowed: false,
      reason: "handoff_budget_would_be_exceeded",
      limit: 60,
      used: 20,
      estimateCents: 41,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("the hook denies with the fixed exhausted code when spent equals the reduced limit", async () => {
    expect(await hookFor(stubStore(100, 60, 40)).check(toolCall, context)).toEqual({
      decision: "deny",
      reasonCode: HANDOFF_BUDGET_EXHAUSTED,
    });
  });

  it("a task that gave away its whole grant is denied at once by hook and guard with nothing spent", async () => {
    const store = stubStore(100, 0, 100);
    expect(await hookAllows(store)).toBe(false);
    expect(await guardAllows(store, 1)).toBe(false);
  });

  it("zero-budget children take nothing: the task can still spend its whole grant", async () => {
    const store = stubStore(100, 0, 0); // five zero-budget gifts add 0 to `given`
    expect(await guardAllows(store, 100)).toBe(true);
    expect(await guardAllows(store, 101)).toBe(false);
  });

  it("a task whose own grant is 0 is denied at once even though it gave nothing", async () => {
    const store = stubStore(0, 0, 0);
    expect(await hookAllows(store)).toBe(false);
    expect(await guardAllows(store, 1)).toBe(false);
  });

  it("a given amount larger than the grant leaves a limit of 0, not a negative one", async () => {
    const store = stubStore(100, 0, 250);
    expect(await hookAllows(store)).toBe(false);
    expect(await guardAllows(store, 1)).toBe(false);
  });

  it("an ordinary run with no handoff is not affected: the guard delegates and the hook uses the plain policy", async () => {
    const store: Store = {
      findByRun: () => Promise.resolve(null),
      spentCentsOnTask: () => Promise.reject(new Error("must not be asked")),
      allocatedCentsOnRun: () => Promise.reject(new Error("must not be asked")),
    };
    const { guard, reserve } = innerGuard();
    expect((await withHandoffBudget(guard, store).reserve(callOf(1_000))).allowed).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect((await hookFor(store).check(toolCall, context)).decision).toBe("allow");
  });
});

describe("AC2: fail closed when the record of gifts cannot answer", () => {
  const brokenGiven: Store = {
    findByRun: () => Promise.resolve(record(100)),
    spentCentsOnTask: () => Promise.resolve(0),
    allocatedCentsOnRun: () => Promise.reject(new Error("db down")),
  };

  it("the guard refuses with budget_check_failed, reports the error and never reaches the wrapped guard", async () => {
    const { guard, reserve } = innerGuard();
    const onError = vi.fn();
    const decision = await withHandoffBudget(guard, brokenGiven, onError).reserve(callOf(1));
    expect(decision).toMatchObject({ allowed: false, reason: "budget_check_failed" });
    expect(reserve).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("the guard still refuses when the error reporter itself throws", async () => {
    const { guard, reserve } = innerGuard();
    const decision = await withHandoffBudget(guard, brokenGiven, () => {
      throw new Error("reporter broke");
    }).reserve(callOf(1));
    expect(decision.allowed).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("the hook does not answer allow: the rejection reaches the loop, which denies", async () => {
    await expect(hookFor(brokenGiven).check(toolCall, context)).rejects.toThrow("db down");
  });

  it("the guard refuses when the spend lookup fails but the gift lookup works", async () => {
    const { guard, reserve } = innerGuard();
    const store: Store = {
      ...brokenGiven,
      spentCentsOnTask: () => Promise.reject(new Error("ledger down")),
      allocatedCentsOnRun: () => Promise.resolve(0),
    };
    expect((await withHandoffBudget(guard, store).reserve(callOf(1))).allowed).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("an unpriced model is refused", async () => {
    const { guard, reserve } = innerGuard();
    const decision = await withHandoffBudget(guard, stubStore(100, 0, 0)).reserve({
      ...callOf(1),
      model: "no-such-model",
    });
    expect(decision).toMatchObject({ allowed: false, reason: "model_not_priced" });
    expect(reserve).not.toHaveBeenCalled();
  });
});
