// AGO-81 round 3: the handoff's budget is checked BEFORE each model call (worst case), reusing the AGO-40 guard.
import { describe, expect, it, vi } from "vitest";

import { createRunEventEmitter } from "../events/run-event-emitter.js";

import { createHandoff } from "./create-handoff.js";
import { withHandoffBudget } from "./handoff-budget-guard.js";
import { createInMemoryHandoffStore } from "./handoff-store.test-helpers.js";

import type { BudgetDecision, BudgetGuard } from "../budget/budget-guard.js";
import type { HandoffGrant, HandoffParty } from "@ago/shared/handoff";

const WS = "11111111-1111-4111-8111-111111111111";
const HUMAN = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL = "claude-haiku-5-5"; // 100 / 500 cents per million tokens

const grant = (capabilityKey: string): HandoffGrant => ({
  capabilityKey,
  tier: 0,
  mode: "automatic",
  isEnabled: true,
});
const party = (agentId: string): HandoffParty => ({
  agentId,
  workspaceId: WS,
  isArchived: false,
  grants: [grant("vault.read")],
  budgetCents: 500,
  dataScope: [],
});

const allowed: BudgetDecision = {
  allowed: true,
  reservation: {
    workspaceId: WS,
    agentId: B,
    cents: 1,
    dayStart: "2026-11-20",
    monthStart: "2026-11-01",
  },
  estimateCents: 1,
};

function inner() {
  const reserve = vi.fn((): Promise<BudgetDecision> => Promise.resolve(allowed));
  const settle = vi.fn(() =>
    Promise.resolve({ costCents: 1, overran: false, ledgerFailed: false }),
  );
  const release = vi.fn(() => Promise.resolve());
  const chargeReserved = vi.fn(() => Promise.resolve());
  const guard: BudgetGuard = { reserve, settle, release, chargeReserved };
  return { guard, reserve, settle, release, chargeReserved };
}

async function handedOff(budgetCents: number) {
  const store = createInMemoryHandoffStore();
  store.setParty(party(A));
  store.setParty(party(B));
  store.setChainForRun("run-a", { workspaceId: WS, requesterMemberId: HUMAN, path: [A] });
  const made = await createHandoff(
    {
      store,
      emitter: createRunEventEmitter({
        workspaceId: WS,
        runId: "run-a",
        store: {
          insert: () => Promise.resolve({ id: "e", seq: 1, created_at: "2026-11-20T00:00:00Z" }),
        },
      }),
      newId: () => "7a5c0000-0000-4000-8000-000000000001",
    },
    { workspaceId: WS, runId: "run-a", agentId: A },
    { to_agent_id: B, title: "t", requested: { budget_cents: budgetCents } },
  );
  if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
  store.setRunTask(WS, "run-b", made.taskId);
  return { store, taskId: made.taskId };
}

const call = (over: object = {}) => ({
  workspaceId: WS,
  agentId: B,
  runId: "run-b",
  model: MODEL,
  inputCharacters: 3_000, // 1000 tokens: 0.1 cent
  maxOutputTokens: 10_000, // 5 cents
  ...over,
});

describe("the handoff budget is checked before each model call", () => {
  it("refuses a call whose worst case could pass the narrowed budget, and never reaches the wrapped guard", async () => {
    const { store } = await handedOff(5); // the worst case is 6 cents (rounded up)
    const { guard, reserve } = inner();
    const decision = await withHandoffBudget(guard, store).reserve(call());
    expect(decision).toMatchObject({
      allowed: false,
      reason: "handoff_budget_would_be_exceeded",
      limit: 5,
      used: 0,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("counts what the task already spent: spent + worst case must fit", async () => {
    const { store, taskId } = await handedOff(10);
    const { guard, reserve } = inner();
    const wrapped = withHandoffBudget(guard, store);
    store.setSpentCents(WS, taskId, 4); // 4 + 6 = 10: fits exactly
    expect((await wrapped.reserve(call())).allowed).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1);
    store.setSpentCents(WS, taskId, 5); // 5 + 6 = 11: could overshoot
    expect(await wrapped.reserve(call())).toMatchObject({
      allowed: false,
      reason: "handoff_budget_would_be_exceeded",
      used: 5,
    });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("denies a model with no price (the worst case cannot be computed)", async () => {
    const { store } = await handedOff(500);
    const { guard, reserve } = inner();
    const wrapped = withHandoffBudget(guard, store);
    expect(await wrapped.reserve(call({ model: "unknown-model" }))).toMatchObject({
      allowed: false,
      reason: "model_not_priced",
    });
    expect(await wrapped.reserve(call({ model: undefined }))).toMatchObject({
      allowed: false,
      reason: "model_not_priced",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails closed when the store cannot answer", async () => {
    const { store } = await handedOff(500);
    const { guard, reserve } = inner();
    const onError = vi.fn();
    const broken = {
      findByRun: store.findByRun.bind(store),
      spentCentsOnTask: () => Promise.reject(new Error("db down")),
    };
    expect(await withHandoffBudget(guard, broken, onError).reserve(call())).toMatchObject({
      allowed: false,
      reason: "budget_check_failed",
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("an ordinary run, or one with no run id, goes straight to the wrapped guard", async () => {
    const { store } = await handedOff(1);
    const { guard, reserve } = inner();
    const wrapped = withHandoffBudget(guard, store);
    expect((await wrapped.reserve(call({ runId: "plain-run" }))).allowed).toBe(true);
    expect((await wrapped.reserve(call({ runId: undefined }))).allowed).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("settle, release and chargeReserved pass through", async () => {
    const { store } = await handedOff(500);
    const { guard, settle, release, chargeReserved } = inner();
    const wrapped = withHandoffBudget(guard, store);
    await wrapped.settle(allowed.reservation, MODEL, { inputTokens: 1, outputTokens: 1 });
    await wrapped.release(allowed.reservation);
    await wrapped.chargeReserved(allowed.reservation);
    expect(settle).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(chargeReserved).toHaveBeenCalledOnce();
  });
});
