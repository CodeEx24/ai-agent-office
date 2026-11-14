import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBudgetGuard } from "../budget/budget-guard.js";
import { createFakeBudgetStore } from "../budget/budget-store.test-helpers.js";
import { createPgBudgetStore } from "../budget/budget-store.js";
import { LOCAL_DATABASE_URL } from "../config.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createAgentLoop } from "./agent-loop.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { BudgetStore } from "../budget/budget-store.js";
import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelResponse } from "./model-provider.js";

/**
 * AGO-40 functional acceptance (tester): the whole path from the agent loop to the ledger, with a fake model.
 * The live-database part skips itself when the shared local Supabase stack is down; run it inside the db lock.
 * Every expected number below is derived from the price table by hand (haiku: 100 / 500 cents per million tokens),
 * not read back from the code under test.
 */

const MODEL = "claude-haiku-5-5";
const AT_MONTH = "month";

const toolCall = (inputTokens: number, outputTokens: number): ModelResponse => ({
  text: "",
  toolCalls: [{ id: "toolu_1", name: "get_current_time", input: {} }],
  usage: { inputTokens, outputTokens },
});
const answer = (inputTokens: number, outputTokens: number): ModelResponse => ({
  text: "done",
  toolCalls: [],
  usage: { inputTokens, outputTokens },
});

interface RunIds {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
}

function build(
  ids: RunIds,
  store: BudgetStore,
  script: (n: number) => ModelResponse | Promise<ModelResponse>,
  maxTokens?: number,
) {
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent", destination: { write: () => undefined } });
  const emitter = createRunEventEmitter({
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
  });
  const taskId = randomUUID();
  const runContext: RunContext = {
    runId: ids.runId,
    workspaceId: ids.workspaceId,
    agent: {
      id: ids.agentId,
      workspaceId: ids.workspaceId,
      name: "Scout",
      role: "Researches.",
      prompt: null,
    },
    task: { id: taskId, workspaceId: ids.workspaceId, title: "Find", description: "Collect." },
  };
  let calls = 0;
  const provider: ModelProvider = {
    model: MODEL,
    complete: async () => {
      calls += 1;
      return script(calls);
    },
  };
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
    ...(maxTokens === undefined ? {} : { limits: { maxTokens } }),
    budget: createBudgetGuard({ store }),
  });
  const ctx: RunExecutionContext = {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    agentId: ids.agentId,
    taskId,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows, modelCalls: () => calls };
}

const newIds = (): RunIds => ({
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  runId: randomUUID(),
});
const typesOf = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const eventsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type);

describe("AC1: a run that reaches its budget stops with a budget event (no database)", () => {
  it("refuses the NEXT model call once the first call used up the agent's daily budget", async () => {
    // Worst case of one haiku call: 4,096 output tokens = 2.05 cents (+ a small prompt) -> held as 3 cents.
    // The first call really costs 1,000 in + 500 out = 0.1 + 0.25 -> 1 cent, so 1 cent is counted afterwards
    // and a second hold of 3 cents no longer fits the 3-cent daily budget.
    const store = createFakeBudgetStore({ dailyBudgetCents: 3 });
    const { loop, ctx, rows, modelCalls } = build(newIds(), store, () => toolCall(1_000, 500));
    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(modelCalls()).toBe(1);
    const budgetEvents = eventsOf(rows, "budget.exceeded");
    expect(budgetEvents.length).toBeGreaterThanOrEqual(1);
    expect(budgetEvents.at(-1)?.payload).toMatchObject({ scope: "agent_daily" });
    expect(typesOf(rows).at(-1)).toBe("run.stopped");
  });

  it("makes no further model call after the run's token budget is reached", async () => {
    const { loop, ctx, rows, modelCalls } = build(
      newIds(),
      createFakeBudgetStore(),
      () => toolCall(600, 600),
      1_000,
    );
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    // 1,200 tokens >= 1,000: the loop must stop after the first call, not make a second one.
    expect(modelCalls()).toBe(1);
    expect(eventsOf(rows, "budget.exceeded")).toHaveLength(1);
    expect(eventsOf(rows, "budget.exceeded")[0]?.payload).toMatchObject({
      scope: "run",
      reason: "run_token_limit_reached",
      limit: 1_000,
      used: 1_200,
    });
  });

  it("never lets a budget stop end with a completed run", async () => {
    const { loop, ctx, rows } = build(
      newIds(),
      createFakeBudgetStore({ monthUsedCents: 100_000 }),
      () => answer(1, 1),
    );
    const outcome = await loop.execute(ctx);
    expect(outcome.end).not.toBe("completed");
    expect(typesOf(rows)).not.toContain("run.completed");
  });
});

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1 from public.budgets_usage limit 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();

describe.skipIf(!live)("agent loop against the live budget ledger", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  const workspaces: string[] = [];

  async function freshAgent(dailyBudgetCents: number): Promise<RunIds> {
    const ids = newIds();
    workspaces.push(ids.workspaceId);
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-40 accept')", [
      ids.workspaceId,
    ]);
    await pool.query(
      "insert into public.agents (id, workspace_id, name, daily_budget_cents) values ($1, $2, 'a', $3)",
      [ids.agentId, ids.workspaceId, dailyBudgetCents],
    );
    return ids;
  }

  const ledger = async (ids: RunIds, scope: "day" | "month") =>
    (
      await pool.query<{ cost: string; tokens: string }>(
        scope === "day"
          ? `select coalesce(sum(cost_used_cents),0)::text as cost, coalesce(sum(tokens_used),0)::text as tokens
               from public.budgets_usage where workspace_id = $1 and agent_id = $2`
          : `select coalesce(sum(cost_used_cents),0)::text as cost, coalesce(sum(tokens_used),0)::text as tokens
               from public.budgets_usage where workspace_id = $1 and agent_id is null`,
        scope === "day" ? [ids.workspaceId, ids.agentId] : [ids.workspaceId],
      )
    ).rows[0];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  });
  afterAll(async () => {
    if (workspaces.length > 0) {
      await pool.query("delete from public.workspaces where id = any($1::uuid[])", [workspaces]);
    }
    await pool.end();
  });

  it(`AC2: ledger totals equal the sum of the run's budget.usage events (${AT_MONTH} and day rows)`, async () => {
    const ids = await freshAgent(1_000);
    // Each call must cost no more than its 3-cent hold (a dearer call is an overrun and stops the run).
    // 9,000 in + 2,000 out = 0.9 + 1.0 = 1.9 -> 2 cents; 3,000 in + 700 out = 0.3 + 0.35 -> 1 cent.
    const usages = [toolCall(9_000, 2_000), answer(3_000, 700)];
    const { loop, ctx, rows } = build(ids, createPgBudgetStore(pool), (n) => usages[n - 1]!);
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("completed");

    const usageEvents = eventsOf(rows, "budget.usage").map(
      (row) => row.payload as { input_tokens: number; output_tokens: number; cost_cents: number },
    );
    expect(usageEvents.map((e) => e.cost_cents)).toEqual([2, 1]);
    const cents = usageEvents.reduce((sum, e) => sum + e.cost_cents, 0);
    const tokens = usageEvents.reduce((sum, e) => sum + e.input_tokens + e.output_tokens, 0);
    expect(cents).toBe(3);
    expect(tokens).toBe(14_700);
    expect(await ledger(ids, "day")).toEqual({ cost: "3", tokens: "14700" });
    expect(await ledger(ids, "month")).toEqual({ cost: "3", tokens: "14700" });
  });

  it("refuses before the model is called when the agent's stored daily budget is smaller than one call's worst case", async () => {
    // Default output allowance alone costs far more than 0 cents; a 1-cent budget with a 1-cent hold already
    // present leaves no room.
    const ids = await freshAgent(1);
    const store = createPgBudgetStore(pool);
    const first = await store.reserve({
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      cents: 1,
      at: new Date(),
    });
    expect(first.ok).toBe(true);
    const { loop, ctx, rows, modelCalls } = build(ids, store, () => answer(1, 1));
    const outcome = await loop.execute(ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(modelCalls()).toBe(0);
    expect(eventsOf(rows, "budget.exceeded")[0]?.payload).toMatchObject({
      scope: "agent_daily",
      reason: "agent_daily_limit_would_be_exceeded",
      limit: 1,
      used: 1,
    });
    expect((await ledger(ids, "day"))?.cost).toBe("1");
  });

  it("two runs of one agent racing for the last budget: exactly one reaches the model", async () => {
    // Budget of 3 cents = exactly one call's worst-case hold (see above), so only one hold fits at a time.
    const ids = await freshAgent(3);
    const store = createPgBudgetStore(pool);
    const second: RunIds = { ...ids, runId: randomUUID() };

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The winner's model call waits until the loser has been stopped, so both reserves happen while the
    // winner's hold is still open (no settle in between).
    const a = build(ids, store, async () => {
      await gate;
      return answer(10, 5);
    });
    const b = build(second, store, async () => {
      await gate;
      return answer(10, 5);
    });
    const stopped = (rows: readonly RunEventRow[]) => typesOf(rows).includes("run.stopped");
    const watcher = (async () => {
      for (let i = 0; i < 200; i += 1) {
        if (stopped(a.rows) || stopped(b.rows)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
    })();
    const [outA, outB] = await Promise.all([a.loop.execute(a.ctx), b.loop.execute(b.ctx), watcher]);

    const ends = [outA.end, outB.end].sort();
    expect(ends).toEqual(["completed", "limit_reached"]);
    expect(a.modelCalls() + b.modelCalls()).toBe(1);
    const loser = a.modelCalls() === 0 ? a : b;
    expect(eventsOf(loser.rows, "budget.exceeded")[0]?.payload).toMatchObject({
      scope: "agent_daily",
    });
  });
});
