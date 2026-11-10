import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createPolicyEngineHook, type PolicySource } from "../policy/index.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createRunLimitsResolver } from "./run-limits.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ModelProvider, ModelResponse } from "./model-provider.js";

// AGO-166 QA (re-test after merging main): loop detection (AC1) and per-agent run limits (AC2) still hold
// together with the REAL policy engine (AGO-34) wired into the loop. A denied tool call that the model
// repeats must end the run as a loop or a limit, must never execute the tool, and must keep emitting
// policy.decision events. No network, no API key, no database: the engine reads an in-memory source.

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";

const usage = { inputTokens: 10, outputTokens: 5 };
const callOf = (name: string, input: unknown = {}): ModelResponse => ({
  text: "",
  toolCalls: [{ id: "toolu_1", name, input }],
  usage,
});

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function tool(name: string, capabilityKey: string) {
  const run = vi.fn(() => Promise.resolve("ran"));
  const agentTool: AgentTool & { run: typeof run } = {
    name,
    description: `${name} tool`,
    tier: 0,
    capabilityKey,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
    run,
  };
  return agentTool;
}

/** A strict agent with NO grants: the engine denies every capability tool as `not_granted`. */
const ungrantedSource: PolicySource = {
  load: () => Promise.resolve({ agent: { mode: "strict", grants: [] }, policies: [] }),
};

function setup(options: {
  readonly registered: AgentTool;
  /** The tool name the model keeps asking for (defaults to the registered tool). */
  readonly calledName?: string;
  readonly runLimits?: unknown;
}) {
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent" });
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
  let requests = 0;
  const provider: ModelProvider = {
    complete: () => {
      requests += 1;
      return Promise.resolve(
        callOf(options.calledName ?? options.registered.name, { query: "layouts" }),
      );
    },
  };
  const loop = createAgentLoop({
    toolOffer: offerAllTools,
    provider,
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext()),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([options.registered]),
    policy: createPolicyEngineHook({ source: ungrantedSource }),
    ...(options.runLimits === undefined
      ? {}
      : {
          limitsResolver: createRunLimitsResolver({
            defaults: { maxSteps: 50, maxTokens: 500_000, maxWallMs: 600_000 },
            source: { get: () => Promise.resolve(options.runLimits) },
          }),
        }),
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
  return { loop, ctx, rows, requests: () => requests };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const payloadsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type).map((row) => row.payload);

describe("AGO-166 QA with the real policy engine (AGO-34)", () => {
  it("AC1: a denied tool call repeated 3 times ends the run as run.loop_detected and the tool never executes", async () => {
    const search = tool("web_search", "web.search");
    const { loop, ctx, rows, requests } = setup({ registered: search });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(requests()).toBe(3);
    expect(search.run).not.toHaveBeenCalled();
    expect(types(rows).at(-1)).toBe("run.loop_detected");
    expect(types(rows)).not.toContain("tool_call.started");
    expect(types(rows)).not.toContain("tool_call.succeeded");
    expect(types(rows)).not.toContain("run.completed");
    expect(payloadsOf(rows, "run.loop_detected")).toEqual([
      expect.objectContaining({ tool_name: "web_search", repeat_count: 3 }),
    ]);
  });

  it("AC1: every one of the 3 denied calls still emits a policy.decision (deny, not_granted) and a policy_denied failure", async () => {
    const search = tool("web_search", "web.search");
    const { loop, ctx, rows } = setup({ registered: search });

    await loop.execute(ctx);

    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision).toEqual(
        expect.objectContaining({ decision: "deny", reason_code: "not_granted" }),
      );
    }
    const failures = payloadsOf(rows, "tool_call.failed");
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure).toEqual(expect.objectContaining({ error_code: "policy_denied" }));
    }
  });

  it("AC2: a per-agent maxSteps below the loop threshold wins: the run ends as limit_reached, tool never executes, decisions still emitted", async () => {
    const search = tool("web_search", "web.search");
    const { loop, ctx, rows, requests } = setup({
      registered: search,
      runLimits: { maxSteps: 2 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 2, end: "limit_reached" });
    expect(requests()).toBe(2);
    expect(search.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "steps", max: 2 }),
    ]);
    expect(types(rows)).not.toContain("run.loop_detected");
    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) {
      expect(decision).toEqual(expect.objectContaining({ decision: "deny" }));
    }
  });

  it("AC2: a per-agent maxSteps above the loop threshold does not hide the loop: the run still ends as loop_detected at 3", async () => {
    const search = tool("web_search", "web.search");
    const { loop, ctx, rows } = setup({ registered: search, runLimits: { maxSteps: 10 } });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(search.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "policy.decision")).toHaveLength(3);
  });

  it("AC1: an unregistered tool the model keeps calling is denied before the engine, never runs, and ends as a loop", async () => {
    const registered = tool("registered_tool", "web.search");
    const { loop, ctx, rows } = setup({ registered, calledName: "does_not_exist" });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(registered.run).not.toHaveBeenCalled();
    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision).toEqual(
        expect.objectContaining({ decision: "deny", reason_code: "tool_not_offered" }),
      );
    }
  });
});
