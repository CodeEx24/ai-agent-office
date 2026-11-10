import { RUN_LIMIT_BOUNDS, agentRunLimitsSchema } from "@ago/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createDenyByDefaultPolicyHook, type PolicyHook } from "./policy-hook.js";
import { createRunLimitsResolver, type AgentRunLimitsSource } from "./run-limits.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "./model-provider.js";
import type { CapabilityTier } from "@ago/shared";

// AGO-166 QA (written by the tester, not the implementer): loop detection (AC1) and per-agent run limits
// (AC2) through the real agent loop with a scripted fake model. No network, no API key, no database.
// The fake secret is built at runtime so no secret-shaped literal sits in the source.

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const FAKE_KEY = ["sk", "ant", "api03", "QA".repeat(8), "zZ9".repeat(6)].join("-");

const usage = (inputTokens = 10, outputTokens = 5) => ({ inputTokens, outputTokens });
const answer = (text: string): ModelResponse => ({ text, toolCalls: [], usage: usage() });
const calls = (toolCalls: readonly ModelToolCall[], u = usage()): ModelResponse => ({
  text: "",
  toolCalls,
  usage: u,
});
const one = (name: string, input: unknown = {}, id = "toolu_1", u = usage()) =>
  calls([{ id, name, input }], u);

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function scripted(script: (n: number, request: ModelRequest) => ModelResponse) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve(script(requests.length, request));
    },
  };
  return { provider, requests };
}

function tool(
  name: string,
  tier: CapabilityTier,
  execute: AgentTool["execute"],
): AgentTool & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(execute);
  return {
    name,
    description: `${name} tool`,
    tier,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
    run,
  };
}

const allowAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "allow", reasonCode: "qa_allow" }),
};

interface SetupOptions {
  readonly provider: ModelProvider;
  readonly tools?: readonly AgentTool[];
  readonly policy?: PolicyHook;
  readonly limitsResolver?: ReturnType<typeof createRunLimitsResolver>;
  readonly now?: () => number;
}

function setup(options: SetupOptions) {
  const rows: RunEventRow[] = [];
  const logLines: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: {
      write: (chunk) => {
        logLines.push(chunk);
      },
    },
  });
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
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider: options.provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext()),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry(options.tools ?? []),
    policy: options.policy ?? allowAll,
    ...(options.limitsResolver === undefined ? {} : { limitsResolver: options.limitsResolver }),
    ...(options.now === undefined ? {} : { now: options.now }),
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
  return { loop, ctx, rows, logLines };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const payloadsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type).map((row) => row.payload);

const DEFAULTS = { maxSteps: 50, maxTokens: 500_000, maxWallMs: 600_000 } as const;
const resolverFor = (override: unknown, defaults = DEFAULTS) =>
  createRunLimitsResolver({ defaults, source: { get: () => Promise.resolve(override) } });

describe("AGO-166 QA, AC1: the same call with the same output 3 times stops the run", () => {
  it("AC1: identical tool, identical canonical arguments and identical output 3 times emits run.loop_detected and stops", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const { provider, requests } = scripted(() => one("search", { query: "layouts" }));
    const { loop, ctx, rows } = setup({ provider, tools: [search] });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(requests).toHaveLength(3);
    expect(search.run).toHaveBeenCalledTimes(3);
    expect(types(rows).at(-1)).toBe("run.loop_detected");
    expect(types(rows)).not.toContain("run.completed");
    expect(types(rows)).not.toContain("run.limit_reached");
    expect(payloadsOf(rows, "run.loop_detected")).toEqual([
      expect.objectContaining({ tool_name: "search", repeat_count: 3 }),
    ]);
  });

  it("AC1: the event holds only the tool name, a hash and a count: no arguments, no output, no secret", async () => {
    const leaky = tool("lookup", 0, () => Promise.resolve(`token is ${FAKE_KEY}`));
    const { provider } = scripted(() => one("lookup", { apiKey: FAKE_KEY, query: "private plan" }));
    const { loop, ctx, rows, logLines } = setup({ provider, tools: [leaky] });

    await loop.execute(ctx);

    const [payload] = payloadsOf(rows, "run.loop_detected");
    // `version` is the event envelope's schema version, not data from the call.
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "call_hash",
      "repeat_count",
      "tool_name",
      "version",
    ]);
    expect(payload?.call_hash).toMatch(/^[0-9a-f]{64}$/);
    const event = JSON.stringify(payloadsOf(rows, "run.loop_detected"));
    expect(event).not.toContain(FAKE_KEY);
    expect(event).not.toContain("private plan");
    expect(event).not.toContain("apiKey");
    // The secret reaches neither the append-only event stream nor the log, loop or not.
    expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
    expect(logLines.join("\n")).not.toContain(FAKE_KEY);
  });

  it("AC1: the same call with a DIFFERENT output each time does not stop the run", async () => {
    let counter = 0;
    const ticker = tool("ticker", 0, () => Promise.resolve(`tick ${String((counter += 1))}`));
    const { provider } = scripted((n) => (n <= 6 ? one("ticker", { same: true }) : answer("done")));
    const { loop, ctx, rows } = setup({ provider, tools: [ticker] });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(ticker.run).toHaveBeenCalledTimes(6);
    expect(types(rows)).not.toContain("run.loop_detected");
    expect(types(rows)).toContain("message.emitted");
  });

  it("AC1: the same output with DIFFERENT arguments each time does not stop the run", async () => {
    const echo = tool("echo", 0, () => Promise.resolve("same output"));
    const { provider } = scripted((n) => (n <= 6 ? one("echo", { n }) : answer("done")));
    const { loop, ctx, rows } = setup({ provider, tools: [echo] });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(types(rows)).not.toContain("run.loop_detected");
  });

  it("AC1: two repeats and then a change do not stop the run, and the count starts again", async () => {
    const outputs = ["a", "a", "b", "b", "a", "a"];
    let index = 0;
    const flip = tool("flip", 0, () => Promise.resolve(outputs[index++] ?? "z"));
    const { provider } = scripted((n) => (n <= 6 ? one("flip", {}) : answer("done")));
    const { loop, ctx, rows } = setup({ provider, tools: [flip] });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("completed");
    expect(types(rows)).not.toContain("run.loop_detected");
  });

  it("AC1: argument key order (at any depth) does not hide a repeat", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const variants = [
      { a: 1, b: { x: 1, y: [1, { p: 1, q: 2 }] } },
      { b: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 },
      { b: { x: 1, y: [1, { p: 1, q: 2 }] }, a: 1 },
    ];
    const { provider } = scripted((n) => one("search", variants[(n - 1) % variants.length]));
    const { loop, ctx, rows } = setup({ provider, tools: [search] });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(types(rows).at(-1)).toBe("run.loop_detected");
  });

  it("AC1: whitespace in the JSON a model sent does not hide a repeat (inputs are parsed first)", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const texts = ['{"q":"a","n":1}', '{ "n" : 1,\n  "q" : "a" }', '{\t"q":"a",   "n":1}'];
    const { provider } = scripted((n) => one("search", JSON.parse(texts[(n - 1) % 3] ?? "{}")));
    const { loop, ctx } = setup({ provider, tools: [search] });

    expect(await loop.execute(ctx)).toEqual({ steps: 3, end: "loop_detected" });
  });

  it("AC1: whitespace INSIDE a string value is a real difference, not a repeat", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const { provider } = scripted((n) =>
      n <= 3 ? one("search", { q: ["a", "a ", " a"][n - 1] }) : answer("done"),
    );
    const { loop, ctx } = setup({ provider, tools: [search] });

    expect((await loop.execute(ctx)).end).toBe("completed");
  });

  it("AC1: three calls in ONE model step also count", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const { provider, requests } = scripted(() =>
      calls([
        { id: "t1", name: "search", input: { q: 1 } },
        { id: "t2", name: "search", input: { q: 1 } },
        { id: "t3", name: "search", input: { q: 1 } },
      ]),
    );
    const { loop, ctx, rows } = setup({ provider, tools: [search] });

    expect(await loop.execute(ctx)).toEqual({ steps: 1, end: "loop_detected" });
    expect(requests).toHaveLength(1);
    expect(types(rows).at(-1)).toBe("run.loop_detected");
  });

  it("AC1: a different tool name with the same arguments and output is not a repeat", async () => {
    const a = tool("alpha", 0, () => Promise.resolve("ok"));
    const b = tool("beta", 0, () => Promise.resolve("ok"));
    const { provider } = scripted((n) =>
      n <= 4 ? one(n % 2 === 0 ? "alpha" : "beta", { q: 1 }) : answer("done"),
    );
    const { loop, ctx, rows } = setup({ provider, tools: [a, b] });

    expect((await loop.execute(ctx)).end).toBe("completed");
    expect(types(rows)).not.toContain("run.loop_detected");
  });

  it("AC1 (security): a repeated DENIED call is a loop, and the loop never executes the tool", async () => {
    const dangerous = tool("send_email", 3, () => Promise.resolve("sent"));
    const { provider, requests } = scripted(() => one("send_email", { to: "x@example.test" }));
    const { loop, ctx, rows } = setup({
      provider,
      tools: [dangerous],
      policy: createDenyByDefaultPolicyHook(),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(requests).toHaveLength(3);
    expect(dangerous.run).not.toHaveBeenCalled();
    expect(types(rows).at(-1)).toBe("run.loop_detected");
  });

  it("AC1 (security): the run ends as loop_detected, never as a completed result", async () => {
    const search = tool("search", 0, () => Promise.resolve("no results"));
    const { provider } = scripted(() => one("search", {}));
    const { loop, ctx, rows } = setup({ provider, tools: [search] });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("loop_detected");
    expect(types(rows)).not.toContain("message.emitted");
    expect(types(rows)).not.toContain("run.completed");
  });
});

describe("AGO-166 QA, AC2: step, token and time limits are configurable per agent", () => {
  it("AC2: an agent's maxSteps overrides the default and the loop emits run.limit_reached for steps", async () => {
    const { provider, requests } = scripted((n) => one("noop", { n }));
    const noop = tool("noop", 0, () => Promise.resolve("ok"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: [noop],
      limitsResolver: resolverFor({ maxSteps: 2 }),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 2, end: "limit_reached" });
    expect(requests).toHaveLength(2);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "steps", max: 2, observed: 2 }),
    ]);
  });

  it("AC2: an agent's maxTokens overrides the default and the loop emits run.limit_reached for tokens", async () => {
    const { provider, requests } = scripted((n) => one("noop", { n }, "t", usage(600, 500)));
    const noop = tool("noop", 0, () => Promise.resolve("ok"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: [noop],
      limitsResolver: resolverFor({ maxTokens: 1_000 }),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(requests).toHaveLength(1);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "tokens", max: 1_000, observed: 1_100 }),
    ]);
  });

  it("AC2: an agent's maxWallMs overrides the default and the loop emits run.limit_reached for time", async () => {
    let clock = 0;
    const slow = tool("slow", 0, () => {
      clock += 600;
      return Promise.resolve("ok");
    });
    const { provider } = scripted((n) => one("slow", { n }));
    const { loop, ctx, rows } = setup({
      provider,
      tools: [slow],
      now: () => clock,
      limitsResolver: resolverFor({ maxWallMs: 1_000 }),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome.end).toBe("limit_reached");
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "time", max: 1_000 }),
    ]);
  });

  it("AC2: an agent with no override (null) gets the defaults", async () => {
    const { provider } = scripted((n) => (n < 5 ? one("noop", { n }) : answer("done")));
    const noop = tool("noop", 0, () => Promise.resolve("ok"));
    const { loop, ctx } = setup({
      provider,
      tools: [noop],
      limitsResolver: resolverFor(null, { ...DEFAULTS, maxSteps: 50 }),
    });

    expect((await loop.execute(ctx)).end).toBe("completed");
  });

  it("AC2: an override ABOVE the cap is clamped to the cap (nobody can set unlimited)", async () => {
    const { provider, requests } = scripted((n) => one("noop", { n }));
    const noop = tool("noop", 0, () => Promise.resolve("ok"));
    const { loop, ctx, rows } = setup({
      provider,
      tools: [noop],
      limitsResolver: resolverFor({ maxSteps: 1_000_000 }),
    });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: RUN_LIMIT_BOUNDS.maxSteps.max, end: "limit_reached" });
    expect(requests).toHaveLength(RUN_LIMIT_BOUNDS.maxSteps.max);
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "steps", max: RUN_LIMIT_BOUNDS.maxSteps.max }),
    ]);
  });

  it.each([0, -5])(
    "AC2: an override below the floor (%s) is clamped up, never 'no steps allowed' nor negative",
    async (value) => {
      const { provider } = scripted((n) => one("noop", { n }));
      const noop = tool("noop", 0, () => Promise.resolve("ok"));
      const { loop, ctx } = setup({
        provider,
        tools: [noop],
        limitsResolver: resolverFor({ maxSteps: value }),
      });

      expect(await loop.execute(ctx)).toEqual({
        steps: RUN_LIMIT_BOUNDS.maxSteps.min,
        end: "limit_reached",
      });
    },
  );

  it("AC2: bounds for tokens and wall time are enforced by the resolver", async () => {
    const scope = { workspaceId: WS, agentId: AGENT };
    const high = await resolverFor({ maxTokens: 999_999_999, maxWallMs: 9_999_999 }).resolve(scope);
    expect(high.maxTokens).toBe(RUN_LIMIT_BOUNDS.maxTokens.max);
    expect(high.maxWallMs).toBe(RUN_LIMIT_BOUNDS.maxWallMs.max);

    const low = await resolverFor({ maxTokens: 1, maxWallMs: 1 }).resolve(scope);
    expect(low.maxTokens).toBe(RUN_LIMIT_BOUNDS.maxTokens.min);
    expect(low.maxWallMs).toBe(RUN_LIMIT_BOUNDS.maxWallMs.min);
  });

  it.each([
    ["a string", { maxSteps: "10" }],
    ["a float", { maxSteps: 1.5 }],
    ["NaN", { maxSteps: Number.NaN }],
    ["Infinity", { maxSteps: Number.POSITIVE_INFINITY }],
    ["an array", [5]],
    ["a bare number", 5],
    ["an unknown key", { unlimited: true }],
  ])("AC2: a malformed override (%s) keeps the defaults", async (_label, override) => {
    const resolved = await resolverFor(override).resolve({ workspaceId: WS, agentId: AGENT });

    expect(resolved).toEqual(DEFAULTS);
  });

  it("AC2: a limits lookup that throws falls back to the defaults and the run is still bounded", async () => {
    const failing: AgentRunLimitsSource = { get: () => Promise.reject(new Error("db down")) };
    const onSourceError = vi.fn();
    const resolver = createRunLimitsResolver({
      defaults: { ...DEFAULTS, maxSteps: 3 },
      source: failing,
      onSourceError,
    });
    const { provider } = scripted((n) => one("noop", { n }));
    const noop = tool("noop", 0, () => Promise.resolve("ok"));
    const { loop, ctx } = setup({ provider, tools: [noop], limitsResolver: resolver });

    expect(await loop.execute(ctx)).toEqual({ steps: 3, end: "limit_reached" });
    expect(onSourceError).toHaveBeenCalledOnce();
  });

  it("AC2: the lookup is scoped to this run's workspace and agent", async () => {
    const get = vi.fn((_scope: { workspaceId: string; agentId: string }) =>
      Promise.resolve({ maxSteps: 1 }),
    );
    const resolver = createRunLimitsResolver({ defaults: DEFAULTS, source: { get } });
    const { provider } = scripted(() => answer("done"));
    const { loop, ctx } = setup({ provider, limitsResolver: resolver });

    await loop.execute(ctx);

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith({ workspaceId: WS, agentId: AGENT });
  });

  it("AC2: one agent's override does not leak into another agent's resolve", async () => {
    const other = "00000000-0000-4000-8000-0000000000a2";
    const resolver = createRunLimitsResolver({
      defaults: DEFAULTS,
      source: {
        get: ({ agentId }) => Promise.resolve(agentId === AGENT ? { maxSteps: 2 } : null),
      },
    });

    expect((await resolver.resolve({ workspaceId: WS, agentId: AGENT })).maxSteps).toBe(2);
    expect((await resolver.resolve({ workspaceId: WS, agentId: other })).maxSteps).toBe(
      DEFAULTS.maxSteps,
    );
  });

  it("AC2: the shared schema (settings form, storage) rejects unknown keys and out-of-bound values", () => {
    expect(agentRunLimitsSchema.safeParse({}).success).toBe(true);
    expect(agentRunLimitsSchema.safeParse({ maxSteps: 10, maxTokens: 2_000 }).success).toBe(true);
    expect(agentRunLimitsSchema.safeParse({ unlimited: true }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxSteps: 201 }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxSteps: 0 }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxTokens: 999 }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxWallMs: 840_001 }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxSteps: 1.5 }).success).toBe(false);
    expect(agentRunLimitsSchema.safeParse({ maxSteps: "10" }).success).toBe(false);
  });
});
