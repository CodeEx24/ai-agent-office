import { describe, expect, it } from "vitest";

import { createBudgetGuard } from "../budget/budget-guard.js";
import { createFakeBudgetStore } from "../budget/budget-store.test-helpers.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createAgentLoop } from "./agent-loop.js";
import { ModelProviderError } from "./model-provider.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";

/**
 * AGO-40: the budget hook in the agent loop. Every refusal and stop must (a) leave the model uncalled, (b) append a
 * `budget.exceeded` event with a specific reason, and (c) end the run as a limit does.
 */

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";

const runContext: RunContext = {
  runId: RUN,
  workspaceId: WS,
  agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
  task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
};

const answer = (inputTokens: number, outputTokens: number): ModelResponse => ({
  text: "done",
  toolCalls: [],
  usage: { inputTokens, outputTokens },
});
const toolCall = (inputTokens: number, outputTokens: number): ModelResponse => ({
  text: "",
  toolCalls: [{ id: "toolu_1", name: "get_current_time", input: {} }],
  usage: { inputTokens, outputTokens },
});

interface SetupOptions {
  /** The provider's model. `null` leaves the property out entirely. */
  readonly model?: string | null;
  readonly script?: (n: number) => ModelResponse;
  readonly complete?: () => Promise<ModelResponse>;
  readonly store?: Parameters<typeof createFakeBudgetStore>[0];
  readonly maxTokens?: number;
  readonly withBudget?: boolean;
}

function setup(options: SetupOptions = {}) {
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent", destination: { write: () => undefined } });
  const emitter = createRunEventEmitter({
    workspaceId: WS,
    runId: RUN,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
  });
  let calls = 0;
  const model = options.model === undefined ? "claude-haiku-5-5" : options.model;
  const provider: ModelProvider = {
    ...(model === null ? {} : { model }),
    complete: (_request: ModelRequest) => {
      calls += 1;
      if (options.complete) return options.complete();
      return Promise.resolve((options.script ?? (() => answer(10, 5)))(calls));
    },
  };
  const store = createFakeBudgetStore(options.store);
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
    tools: createToolRegistry([getCurrentTimeTool]),
    policy: { check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }) },
    ...(options.maxTokens === undefined ? {} : { limits: { maxTokens: options.maxTokens } }),
    ...(options.withBudget === false ? {} : { budget: createBudgetGuard({ store }) }),
  });
  const ctx: RunExecutionContext = {
    workspaceId: WS,
    runId: RUN,
    agentId: AGENT,
    taskId: TASK,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows, store, modelCalls: () => calls };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const payloadOf = (rows: readonly RunEventRow[], type: string) =>
  rows.find((row) => row.type === type)?.payload;

describe("agent loop: money budget (AGO-40)", () => {
  it("settles the real cost and reports it on budget.usage; totals match the ledger", async () => {
    const { loop, ctx, rows, store } = setup({ script: () => answer(1_000, 500) });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("completed");
    expect(payloadOf(rows, "budget.usage")).toMatchObject({
      input_tokens: 1_000,
      output_tokens: 500,
      cost_cents: 1,
    });
    // AC2: the ledger holds exactly the usage the events recorded.
    expect(store.tokensUsed()).toBe(1_500);
    expect(store.dayUsed()).toBe(1);
    expect(store.monthUsed()).toBe(1);
  });

  it("refuses BEFORE the call when the agent's daily budget is spent: model not called, event appended", async () => {
    const { loop, ctx, rows, modelCalls } = setup({
      store: { dailyBudgetCents: 10, dayUsedCents: 10 },
    });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(types(rows)).toEqual([
      "step.started",
      "step.completed",
      "budget.exceeded",
      "run.stopped",
    ]);
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      scope: "agent_daily",
      reason: "agent_daily_limit_would_be_exceeded",
      limit: 10,
      used: 10,
    });
    expect(payloadOf(rows, "run.stopped")).toMatchObject({
      stopped_by: "budget",
      reason: "agent_daily_limit_would_be_exceeded",
    });
  });

  it("refuses when the workspace's monthly budget would be exceeded", async () => {
    const { loop, ctx, rows, modelCalls } = setup({
      store: { monthlyBudgetCents: 20, monthUsedCents: 20 },
    });
    expect((await loop.execute(ctx)).end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      scope: "workspace_monthly",
      reason: "workspace_monthly_limit_would_be_exceeded",
    });
  });

  it("DENIES a model with no price: the call is never made", async () => {
    const { loop, ctx, rows, modelCalls } = setup({ model: "claude-unknown-9" });
    expect((await loop.execute(ctx)).end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      scope: "pricing",
      reason: "model_not_priced",
    });
  });

  it("DENIES a provider that does not name its model", async () => {
    const { loop, ctx, rows, modelCalls } = setup({ model: null });
    expect((await loop.execute(ctx)).end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({ reason: "model_not_priced" });
  });

  it("DENIES when the ledger cannot answer", async () => {
    const { loop, ctx, rows, modelCalls, store } = setup();
    store.failNext("reserve");
    expect((await loop.execute(ctx)).end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      scope: "ledger",
      reason: "budget_check_failed",
    });
  });

  it("an overrun that still wants tools records it and STOPS the run", async () => {
    const { loop, ctx, rows } = setup({ script: () => toolCall(500_000, 100_000) });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      reason: "call_cost_overran_reservation",
      used: 100,
    });
    // `limit` is what had been reserved for the call: a small worst-case estimate, far below the real 100 cents.
    const exceeded = payloadOf(rows, "budget.exceeded");
    expect(Number(exceeded?.limit)).toBeGreaterThan(0);
    expect(Number(exceeded?.limit)).toBeLessThan(100);
    expect(types(rows).at(-1)).toBe("run.stopped");
    expect(types(rows)).not.toContain("tool_call.requested");
  });

  it("an overrun on the final answer records the event and lets the run complete", async () => {
    const { loop, ctx, rows } = setup({ script: () => answer(500_000, 100_000) });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("completed");
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      reason: "call_cost_overran_reservation",
    });
  });

  it("gives the held cents back when the provider rejects the call", async () => {
    const { loop, ctx, store } = setup({
      complete: () => Promise.reject(new ModelProviderError("rejected", 400, false)),
    });
    await expect(loop.execute(ctx)).rejects.toBeDefined();
    expect(store.dayUsed()).toBe(0);
    expect(store.monthUsed()).toBe(0);
  });

  it("emits budget.exceeded before run.limit_reached when the run's token budget is reached", async () => {
    const { loop, ctx, rows } = setup({ script: () => toolCall(60, 60), maxTokens: 100 });
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(payloadOf(rows, "budget.exceeded")).toMatchObject({
      scope: "run",
      reason: "run_token_limit_reached",
      limit: 100,
      used: 120,
    });
    const order = types(rows);
    expect(order.indexOf("budget.exceeded")).toBeLessThan(order.indexOf("run.limit_reached"));
  });

  it("without a budget wired the loop behaves as before (no cost, no ledger)", async () => {
    const { loop, ctx, rows } = setup({ withBudget: false });
    expect((await loop.execute(ctx)).end).toBe("completed");
    expect(payloadOf(rows, "budget.usage")).not.toHaveProperty("cost_cents");
  });
});
