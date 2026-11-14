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
import { createClaudeProvider } from "./claude-provider.js";
import { ModelProviderError } from "./model-provider.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { BudgetStore } from "../budget/budget-store.js";
import type { RunExecutionContext } from "../queue/run-processor.js";
import type { ModelProvider, ModelRequest } from "./model-provider.js";

/**
 * AGO-40 round 2 (tester): the security fix. What happens to the held cents when a model call fails.
 *  - the provider ANSWERED with an HTTP error status: it did no work, so the held cents are given back;
 *  - the outcome is UNKNOWN (connection dropped after send, malformed 200, abort after send): it may have been billed,
 *    so the hold is kept and counted as spent at its worst case, on the agent-day row AND the workspace-month row,
 *    with a `budget.exceeded` event (scope ledger, reason call_outcome_unknown_charged).
 * Plus the UTF-8 sizing of the pre-call hold.
 *
 * The real Claude provider runs against a fake `fetch`, so the failure shapes are the ones production produces.
 * No real model call is made. Expected numbers are derived by hand from the price table (haiku: 100 cents per
 * million input tokens, 500 per million output tokens) and the default output allowance of 4,096 tokens:
 *   output worst case = 4,096 * 500 / 1e6 = 2.048 cents; a tiny prompt adds < 0.01 cent; rounded up -> 3 cents.
 */

const MODEL = "claude-haiku-5-5";
const TINY_PROMPT_HOLD_CENTS = 3;

interface Ids {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
}
const newIds = (): Ids => ({
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  runId: randomUUID(),
});

interface BuildOptions {
  readonly provider: ModelProvider;
  readonly store: BudgetStore;
  readonly taskDescription?: string;
  readonly signal?: AbortSignal;
}

function build(ids: Ids, options: BuildOptions) {
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
    task: {
      id: taskId,
      workspaceId: ids.workspaceId,
      title: "Find",
      description: options.taskDescription ?? "Collect.",
    },
  };
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider: options.provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([getCurrentTimeTool]),
    policy: { check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }) },
    budget: createBudgetGuard({ store: options.store }),
  });
  const ctx: RunExecutionContext = {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    agentId: ids.agentId,
    taskId,
    attempt: 0,
    logger,
    emitter,
    signal: options.signal ?? new AbortController().signal,
  };
  return { loop, ctx, rows };
}

const claude = (fakeFetch: typeof fetch): ModelProvider =>
  createClaudeProvider({ apiKey: "sk-test-not-real", model: MODEL, fetch: fakeFetch });

const httpError =
  (status: number): typeof fetch =>
  () =>
    Promise.resolve(new Response("{}", { status }));
const connectionReset: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
const okWithBody =
  (body: string): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );

const eventsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type);

/** A provider that never answers until the request is aborted, like a call that was sent and is still in flight. */
function hangingProvider(onSent: () => void): ModelProvider {
  return {
    model: MODEL,
    complete: (request: ModelRequest) =>
      new Promise((_resolve, reject) => {
        onSent();
        request.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
}

const UNKNOWN_EVENT = {
  scope: "ledger",
  reason: "call_outcome_unknown_charged",
  limit: TINY_PROMPT_HOLD_CENTS,
  used: TINY_PROMPT_HOLD_CENTS,
};

describe("security fix: a rejected call gives the held cents back (fake ledger)", () => {
  it.each([400, 401, 429, 500, 529])(
    "leaves nothing counted on either row when the provider answers with HTTP %i",
    async (status) => {
      const store = createFakeBudgetStore();
      const { loop, ctx, rows } = build(newIds(), { provider: claude(httpError(status)), store });
      await expect(loop.execute(ctx)).rejects.toBeInstanceOf(Error);
      expect(store.dayUsed()).toBe(0);
      expect(store.monthUsed()).toBe(0);
      expect(store.tokensUsed()).toBe(0);
      expect(eventsOf(rows, "budget.exceeded")).toHaveLength(0);
    },
  );

  it("a ModelProviderError with a status of 0 is still an answered call, so its hold is released", async () => {
    // Boundary of `status !== undefined`: a falsy status must not be treated as "unknown".
    const store = createFakeBudgetStore();
    const { loop, ctx } = build(newIds(), {
      provider: {
        model: MODEL,
        complete: () => Promise.reject(new ModelProviderError("x", 0, false)),
      },
      store,
    });
    await expect(loop.execute(ctx)).rejects.toBeDefined();
    expect(store.dayUsed()).toBe(0);
    expect(store.monthUsed()).toBe(0);
  });
});

describe("security fix: an unknown outcome keeps the hold as spend (fake ledger)", () => {
  const cases: readonly (readonly [string, typeof fetch])[] = [
    ["the connection drops after the request was sent", connectionReset],
    ["a 200 answer has a body that is not JSON", okWithBody("not json {")],
    ["a 200 answer is JSON of the wrong shape", okWithBody(JSON.stringify({ content: "x" }))],
    ["a 200 answer is truncated", okWithBody('{"content":[{"type":"text","text":"hi"')],
    [
      "a 200 answer carries a non-integer usage figure",
      okWithBody(JSON.stringify({ content: [], usage: { input_tokens: 1.5, output_tokens: 2 } })),
    ],
  ];

  it.each(cases)(
    "counts the worst-case hold as spent on the day row and the month row when %s",
    async (_name, fakeFetch) => {
      const store = createFakeBudgetStore();
      const { loop, ctx, rows } = build(newIds(), { provider: claude(fakeFetch), store });
      await expect(loop.execute(ctx)).rejects.toBeInstanceOf(Error);

      expect(store.dayUsed()).toBe(TINY_PROMPT_HOLD_CENTS);
      expect(store.monthUsed()).toBe(TINY_PROMPT_HOLD_CENTS);
      const events = eventsOf(rows, "budget.exceeded");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject(UNKNOWN_EVENT);
    },
  );

  it("records tokens as 0 for an unanswered call: only money is counted", async () => {
    const store = createFakeBudgetStore();
    const { loop, ctx } = build(newIds(), { provider: claude(connectionReset), store });
    await expect(loop.execute(ctx)).rejects.toBeDefined();
    expect(store.tokensUsed()).toBe(0);
  });

  it("counts the hold as spent when the run is aborted after the request was sent", async () => {
    const store = createFakeBudgetStore();
    const controller = new AbortController();
    let sent!: () => void;
    const wasSent = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { loop, ctx, rows } = build(newIds(), {
      provider: hangingProvider(() => {
        sent();
      }),
      store,
      signal: controller.signal,
    });
    const running = loop.execute(ctx).then(
      () => "resolved",
      () => "rejected",
    );
    await wasSent;
    controller.abort();
    await running;

    expect(store.dayUsed()).toBe(TINY_PROMPT_HOLD_CENTS);
    expect(store.monthUsed()).toBe(TINY_PROMPT_HOLD_CENTS);
    expect(eventsOf(rows, "budget.exceeded")[0]?.payload).toMatchObject(UNKNOWN_EVENT);
  });

  it("holds the spent cents against the next call: a second run cannot reuse them", async () => {
    // Daily budget of 5 cents; each unknown-outcome call is charged 3. The second run's 3-cent hold (3 + 3 > 5)
    // must be refused before its model call.
    const store = createFakeBudgetStore({ dailyBudgetCents: 5 });
    const ids = newIds();
    let secondCalls = 0;
    const first = build(ids, { provider: claude(connectionReset), store });
    await expect(first.loop.execute(first.ctx)).rejects.toBeDefined();
    const second = build(
      { ...ids, runId: randomUUID() },
      {
        provider: {
          model: MODEL,
          complete: () => {
            secondCalls += 1;
            return Promise.reject(new Error("must not be reached"));
          },
        },
        store,
      },
    );
    const outcome = await second.loop.execute(second.ctx);
    expect(outcome.end).toBe("limit_reached");
    expect(secondCalls).toBe(0);
    expect(eventsOf(second.rows, "budget.exceeded")[0]?.payload).toMatchObject({
      scope: "agent_daily",
      limit: 5,
      used: 3,
    });
  });
});

describe("UTF-8 sizing of the pre-call hold", () => {
  /** Runs one call that fails after reserve, and returns what was held and what the provider was sent. */
  async function heldFor(taskDescription: string) {
    const fake = createFakeBudgetStore({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000 });
    const held: number[] = [];
    const store: BudgetStore = {
      ...fake,
      reserve: async (input) => {
        held.push(input.cents);
        return fake.reserve(input);
      },
    };
    let seen: ModelRequest | undefined;
    const provider: ModelProvider = {
      model: MODEL,
      complete: (request) => {
        seen = request;
        return Promise.reject(new ModelProviderError("stop here", 400, false));
      },
    };
    const { loop, ctx } = build(newIds(), { provider, store, taskDescription });
    await expect(loop.execute(ctx)).rejects.toBeDefined();
    const request = seen;
    if (request === undefined) throw new Error("the provider was never called");
    const encoder = new TextEncoder();
    const utf8Bytes =
      encoder.encode(request.system).length +
      request.messages.reduce((sum, m) => sum + encoder.encode(m.content).length, 0) +
      encoder.encode(JSON.stringify(request.tools)).length;
    const utf16Units =
      request.system.length +
      request.messages.reduce((sum, m) => sum + m.content.length, 0) +
      JSON.stringify(request.tools).length;
    return { held: held[0] ?? -1, utf8Bytes, utf16Units };
  }

  // Price table, by hand: haiku input 100 cents per million tokens, output 500; output allowance 4,096 tokens.
  const holdFor = (inputTokens: number) => Math.ceil((inputTokens * 100 + 4_096 * 500) / 1_000_000);

  it("holds at least the byte-based estimate for a CJK prompt, more than a UTF-16 count would", async () => {
    const { held, utf8Bytes, utf16Units } = await heldFor("漢字".repeat(60_000));
    // Sanity: the fixture really is multi-byte heavy.
    expect(utf8Bytes).toBeGreaterThan(utf16Units * 2);
    expect(held).toBeGreaterThanOrEqual(holdFor(Math.ceil(utf8Bytes / 3)));
    expect(held).toBeGreaterThan(holdFor(Math.ceil(utf16Units / 3)));
  });

  it("holds at least the byte-based estimate for an emoji prompt, more than a UTF-16 count would", async () => {
    const { held, utf8Bytes, utf16Units } = await heldFor("😀🚀".repeat(60_000));
    expect(utf8Bytes).toBeGreaterThan(utf16Units * 1.9);
    expect(held).toBeGreaterThanOrEqual(holdFor(Math.ceil(utf8Bytes / 3)));
    expect(held).toBeGreaterThan(holdFor(Math.ceil(utf16Units / 3)));
  });

  it("holds the same for an ASCII prompt as the plain character count says (bytes equal characters)", async () => {
    const { held, utf8Bytes, utf16Units } = await heldFor("abc ".repeat(20_000));
    expect(utf8Bytes).toBe(utf16Units);
    expect(held).toBe(holdFor(Math.ceil(utf8Bytes / 3)));
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

describe.skipIf(!live)("security fix against the live Postgres ledger", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  const workspaces: string[] = [];

  async function freshAgent(dailyBudgetCents = 1_000): Promise<Ids> {
    const ids = newIds();
    workspaces.push(ids.workspaceId);
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-40 outcome')", [
      ids.workspaceId,
    ]);
    await pool.query(
      "insert into public.agents (id, workspace_id, name, daily_budget_cents) values ($1, $2, 'a', $3)",
      [ids.agentId, ids.workspaceId, dailyBudgetCents],
    );
    return ids;
  }

  const ledger = async (ids: Ids, scope: "day" | "month") =>
    (
      await pool.query<{ cost: string; tokens: string; rows: string }>(
        scope === "day"
          ? `select coalesce(sum(cost_used_cents),0)::text as cost, coalesce(sum(tokens_used),0)::text as tokens,
                    count(*)::text as rows
               from public.budgets_usage where workspace_id = $1 and agent_id = $2`
          : `select coalesce(sum(cost_used_cents),0)::text as cost, coalesce(sum(tokens_used),0)::text as tokens,
                    count(*)::text as rows
               from public.budgets_usage where workspace_id = $1 and agent_id is null`,
        scope === "day" ? [ids.workspaceId, ids.agentId] : [ids.workspaceId],
      )
    ).rows[0];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  });
  afterAll(async () => {
    if (workspaces.length > 0) {
      await pool.query("delete from public.workspaces where id = any($1::uuid[])", [workspaces]);
    }
    await pool.end();
  });

  it.each([400, 429, 500])(
    "an HTTP %i answer leaves 0 cents on the agent-day and workspace-month rows",
    async (status) => {
      const ids = await freshAgent();
      const { loop, ctx } = build(ids, {
        provider: claude(httpError(status)),
        store: createPgBudgetStore(pool),
      });
      await expect(loop.execute(ctx)).rejects.toBeDefined();
      expect(await ledger(ids, "day")).toMatchObject({ cost: "0", tokens: "0" });
      expect(await ledger(ids, "month")).toMatchObject({ cost: "0", tokens: "0" });
    },
  );

  it.each([
    ["the connection drops after send", connectionReset],
    ["a 200 body is not JSON", okWithBody("<html>")],
    ["a 200 body has the wrong shape", okWithBody(JSON.stringify({ nope: true }))],
  ] as const)(
    "keeps %s as 3 spent cents on BOTH the agent-day and workspace-month rows",
    async (_name, fakeFetch) => {
      const ids = await freshAgent();
      const { loop, ctx, rows } = build(ids, {
        provider: claude(fakeFetch),
        store: createPgBudgetStore(pool),
      });
      await expect(loop.execute(ctx)).rejects.toBeDefined();
      expect(await ledger(ids, "day")).toMatchObject({ cost: "3", tokens: "0", rows: "1" });
      expect(await ledger(ids, "month")).toMatchObject({ cost: "3", tokens: "0", rows: "1" });
      expect(eventsOf(rows, "budget.exceeded")[0]?.payload).toMatchObject(UNKNOWN_EVENT);
    },
  );

  it("keeps the hold as spend on both rows when the run is aborted after send", async () => {
    const ids = await freshAgent();
    const controller = new AbortController();
    let sent!: () => void;
    const wasSent = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { loop, ctx } = build(ids, {
      provider: hangingProvider(() => {
        sent();
      }),
      store: createPgBudgetStore(pool),
      signal: controller.signal,
    });
    const running = loop.execute(ctx).then(
      () => undefined,
      () => undefined,
    );
    await wasSent;
    controller.abort();
    await running;
    expect(await ledger(ids, "day")).toMatchObject({ cost: "3", tokens: "0" });
    expect(await ledger(ids, "month")).toMatchObject({ cost: "3", tokens: "0" });
  });

  it("an unknown outcome counts against the agent's daily budget: the next run is refused", async () => {
    // Budget 5 cents, each unknown call is charged 3.
    const ids = await freshAgent(5);
    const store = createPgBudgetStore(pool);
    const first = build(ids, { provider: claude(connectionReset), store });
    await expect(first.loop.execute(first.ctx)).rejects.toBeDefined();
    let secondCalls = 0;
    const second = build(
      { ...ids, runId: randomUUID() },
      {
        provider: {
          model: MODEL,
          complete: () => {
            secondCalls += 1;
            return Promise.reject(new Error("must not be reached"));
          },
        },
        store,
      },
    );
    expect((await second.loop.execute(second.ctx)).end).toBe("limit_reached");
    expect(secondCalls).toBe(0);
    expect(await ledger(ids, "day")).toMatchObject({ cost: "3" });
  });
});
