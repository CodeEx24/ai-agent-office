import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createBudgetGuard } from "../budget/budget-guard.js";
import { createFakeBudgetStore } from "../budget/budget-store.test-helpers.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createHandoff } from "../handoff/create-handoff.js";
import { withHandoffBudget } from "../handoff/handoff-budget-guard.js";
import { createInMemoryHandoffStore } from "../handoff/handoff-store.test-helpers.js";
import { createLogger } from "../logger.js";
import { createAgentLoop } from "./agent-loop.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { createToolRegistry, type AgentTool } from "./tools.js";

import type { BudgetDecision, BudgetGuard } from "../budget/budget-guard.js";
import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelResponse } from "./model-provider.js";
import type { HandoffGrant, HandoffParty } from "@ago/shared/handoff";

/**
 * AGO-81 round 3 functional acceptance (tester): the REAL agent loop, the REAL AGO-40 budget guard wrapped by the
 * REAL `withHandoffBudget`, a stub model provider and in-memory stores. A model call on a handed-off task must be
 * refused BEFORE the provider is reached when it could pass the budget the sender passed on.
 * Expected numbers are derived by hand from the price table (haiku: 100 / 500 cents per million tokens):
 *   one call that really used 1,000 in + 500 out = 0.1 + 0.25 cent -> 1 cent (rounded up);
 *   the worst case held before a call = 4,096 output tokens (2.048 cents) + a small prompt -> 3 cents.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const HUMAN = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MODEL = "claude-haiku-5-5";

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

// A tool whose input differs per call, so the loop's repeated-call detector does not end the run before the budget does.
const noteTool: AgentTool = {
  name: "note",
  description: "Takes a number.",
  tier: 0,
  inputSchema: z.strictObject({ n: z.number() }),
  modelInputSchema: {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
    additionalProperties: false,
  },
  execute: () => Promise.resolve("ok"),
};
let callCounter = 0;
const toolCall = (): ModelResponse => {
  callCounter += 1;
  return {
    text: "",
    toolCalls: [{ id: `toolu_${String(callCounter)}`, name: "note", input: { n: callCounter } }],
    usage: { inputTokens: 1_000, outputTokens: 500 },
  };
};
const answer = (): ModelResponse => ({
  text: "done",
  toolCalls: [],
  usage: { inputTokens: 1_000, outputTokens: 500 },
});

/** Hand a task from A to B with the given budget; the receiver's run `RUN_B` works on it. */
async function handedOffTask(budgetCents: number) {
  const handoffStore = createInMemoryHandoffStore();
  handoffStore.setParty(party(A));
  handoffStore.setParty(party(B));
  handoffStore.setChainForRun("run-a", { workspaceId: WS, requesterMemberId: HUMAN, path: [A] });
  const made = await createHandoff(
    {
      store: handoffStore,
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
  handoffStore.setRunTask(WS, RUN_B, made.taskId);
  return { handoffStore, taskId: made.taskId };
}

interface BuildOptions {
  readonly handoffStore: ReturnType<typeof createInMemoryHandoffStore>;
  readonly taskId: string;
  readonly runId: string;
  /** Wrap the guard so a test can see what reached it. */
  readonly spyOnInner?: (guard: BudgetGuard) => BudgetGuard;
  readonly script: (n: number) => ModelResponse;
}

function build(options: BuildOptions) {
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent", destination: { write: () => undefined } });
  const emitter = createRunEventEmitter({
    workspaceId: WS,
    runId: options.runId,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        // What the real worker's run_events + spentCentsOnTask would show: every `budget.usage` cost on the task.
        if (row.type === "budget.usage") {
          const cost = (row.payload as { cost_cents?: number }).cost_cents ?? 0;
          void options.handoffStore.spentCentsOnTask(WS, options.taskId).then((spent) => {
            options.handoffStore.setSpentCents(WS, options.taskId, spent + cost);
          });
        }
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
  });
  const runContext: RunContext = {
    runId: options.runId,
    workspaceId: WS,
    agent: { id: B, workspaceId: WS, name: "Receiver", role: "Does it.", prompt: null },
    task: { id: options.taskId, workspaceId: WS, title: "Find", description: "Collect." },
  };
  let calls = 0;
  const provider: ModelProvider = {
    model: MODEL,
    complete: () => {
      calls += 1;
      return Promise.resolve(options.script(calls));
    },
  };
  const realGuard = createBudgetGuard({
    store: createFakeBudgetStore({ dailyBudgetCents: 5_000 }),
  });
  const inner = options.spyOnInner === undefined ? realGuard : options.spyOnInner(realGuard);
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([noteTool]),
    policy: { check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }) },
    budget: withHandoffBudget(inner, options.handoffStore),
  });
  const ctx: RunExecutionContext = {
    workspaceId: WS,
    runId: options.runId,
    agentId: B,
    taskId: options.taskId,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows, modelCalls: () => calls };
}

const eventsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type);

describe("AC2: a run on a handoff task cannot spend past the budget its sender passed on (agent loop)", () => {
  it("never calls the model when the worst case of the first call is above the handoff budget", async () => {
    const { handoffStore, taskId } = await handedOffTask(2); // worst case is 3 cents
    const { loop, ctx, rows, modelCalls } = build({
      handoffStore,
      taskId,
      runId: RUN_B,
      script: toolCall,
    });
    const outcome = await loop.execute(ctx);

    expect(modelCalls()).toBe(0);
    expect(outcome.end).toBe("limit_reached");
    expect(eventsOf(rows, "budget.exceeded").at(-1)?.payload).toMatchObject({
      scope: "run",
      reason: "handoff_budget_would_be_exceeded",
      limit: 2,
      used: 0,
    });
    expect(rows.at(-1)?.type).toBe("run.stopped");
    expect(eventsOf(rows, "budget.usage")).toHaveLength(0);
  });

  it("stops before the call that could pass the budget, so recorded spend never exceeds it", async () => {
    // Budget 7 cents; each real call costs 1; a call is allowed while spent + 3 <= 7, so the calls at spent
    // 0, 1, 2, 3, 4 happen (5 calls, 5 cents) and the next, at spent 5 (5 + 3 = 8 > 7), is refused.
    const { handoffStore, taskId } = await handedOffTask(7);
    const { loop, ctx, rows, modelCalls } = build({
      handoffStore,
      taskId,
      runId: RUN_B,
      script: toolCall,
    });
    const outcome = await loop.execute(ctx);

    expect(modelCalls()).toBe(5);
    expect(await handoffStore.spentCentsOnTask(WS, taskId)).toBe(5);
    expect(outcome.end).toBe("limit_reached");
    expect(eventsOf(rows, "budget.exceeded").at(-1)?.payload).toMatchObject({
      reason: "handoff_budget_would_be_exceeded",
      limit: 7,
      used: 5,
    });
  });

  it("lets a run finish when the handoff budget is ample", async () => {
    const { handoffStore, taskId } = await handedOffTask(100);
    const { loop, ctx, rows, modelCalls } = build({
      handoffStore,
      taskId,
      runId: RUN_B,
      script: (n) => (n === 1 ? toolCall() : answer()),
    });
    const outcome = await loop.execute(ctx);

    expect(modelCalls()).toBe(2);
    expect(outcome.end).not.toBe("limit_reached");
    expect(eventsOf(rows, "budget.exceeded")).toHaveLength(0);
  });

  it("counts spend by an earlier run on the same task: a second run on a spent task makes no call", async () => {
    const { handoffStore, taskId } = await handedOffTask(7);
    handoffStore.setSpentCents(WS, taskId, 5); // an earlier run already spent 5 of 7
    handoffStore.setRunTask(WS, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", taskId);
    const { loop, ctx, modelCalls } = build({
      handoffStore,
      taskId,
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      script: toolCall,
    });
    await loop.execute(ctx);
    expect(modelCalls()).toBe(0);
  });

  it("an ordinary run (no handoff) reaches the wrapped guard unchanged and is not held to any handoff cap", async () => {
    const { handoffStore, taskId } = await handedOffTask(1);
    handoffStore.setSpentCents(WS, taskId, 1_000); // a spent handoff task elsewhere must not matter
    const seen: { runId: string | undefined; model: string | undefined }[] = [];
    const { loop, ctx, modelCalls } = build({
      handoffStore,
      taskId: "ffffffff-aaaa-4fff-8fff-ffffffffffff",
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", // never linked to a handoff task
      spyOnInner: (guard) => ({
        ...guard,
        reserve: (call): Promise<BudgetDecision> => {
          seen.push({ runId: call.runId, model: call.model });
          return guard.reserve(call);
        },
      }),
      script: (n) => (n === 1 ? toolCall() : answer()),
    });
    const outcome = await loop.execute(ctx);

    expect(outcome.end).not.toBe("limit_reached");
    expect(modelCalls()).toBe(2);
    expect(seen).toEqual([
      { runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", model: MODEL },
      { runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", model: MODEL },
    ]);
  });

  it("still applies the agent's own daily budget on a handoff run with plenty of handoff budget", async () => {
    const { handoffStore, taskId } = await handedOffTask(100);
    let reached = 0;
    const { loop, ctx, modelCalls } = build({
      handoffStore,
      taskId,
      runId: RUN_B,
      spyOnInner: () => ({
        reserve: (): Promise<BudgetDecision> => {
          reached += 1;
          return Promise.resolve({
            allowed: false,
            scope: "agent_daily",
            reason: "agent_daily_limit_would_be_exceeded",
            limit: 1,
            used: 1,
          });
        },
        settle: () => Promise.reject(new Error("unused")),
        release: () => Promise.resolve(),
        chargeReserved: () => Promise.resolve(),
      }),
      script: toolCall,
    });
    const outcome = await loop.execute(ctx);

    expect(reached).toBe(1);
    expect(modelCalls()).toBe(0);
    expect(outcome.end).toBe("limit_reached");
  });
});
