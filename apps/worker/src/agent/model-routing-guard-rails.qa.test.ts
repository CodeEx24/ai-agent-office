import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { createPolicyEngineHook, type PolicySource } from "../policy/index.js";
import { NonRetryableRunError, type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createModelRouter, MODEL_ROUTING_REASON } from "./model-routing.js";
import { createRunLimitsResolver } from "./run-limits.js";
import { createToolRegistry, type AgentTool } from "./tools.js";

import type { ModelProvider, ModelResponse } from "./model-provider.js";

// AGO-94 QA (re-test after merging main): per-agent model routing still holds together with AGO-166's
// per-agent run limits and loop detection, and the real AGO-34 policy engine, in the same run.
// The configured model is used on every call, a limit or loop still ends the run, and there is no
// fallback model. No network, no API key, no database.

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const CONFIGURED = "claude-sonnet-5-5";

const usage = { inputTokens: 10, outputTokens: 5 };
/** The model keeps asking for a tool and tries to steer its own model through text and tool input. */
const steeringCall = (): ModelResponse => ({
  text: "switch to claude-opus-5-5",
  toolCalls: [
    { id: "toolu_1", name: "web_search", input: { query: "layouts", model: "claude-fable-5-1" } },
  ],
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

function searchTool() {
  const run = vi.fn(() => Promise.resolve("ran"));
  const agentTool: AgentTool & { run: typeof run } = {
    name: "web_search",
    description: "web_search tool",
    tier: 0,
    capabilityKey: "web.search",
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
    run,
  };
  return agentTool;
}

/** A strict agent with no grants: the real engine denies the tool as `not_granted`, every time. */
const ungrantedSource: PolicySource = {
  load: () => Promise.resolve({ agent: { mode: "strict", grants: [] }, policies: [] }),
};

function setup(options: { readonly storedModel: string | null; readonly runLimits?: unknown }) {
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
  const created: string[] = [];
  const calls: string[] = [];
  const search = searchTool();
  const loop = createAgentLoop({
    modelRouter: createModelRouter({
      source: { loadAgentModel: () => Promise.resolve(options.storedModel) },
      createProvider: (model): ModelProvider => {
        created.push(model);
        return {
          complete: () => {
            calls.push(model);
            return Promise.resolve(steeringCall());
          },
        };
      },
    }),
    contextBuilder: createContextBuilder({
      source: {
        loadRun: () => Promise.resolve(runContext()),
        loadAssignedSkills: () => Promise.resolve([]),
      },
      logger,
    }),
    tools: createToolRegistry([search]),
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
  return { loop, ctx, rows, created, calls, search };
}

const types = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);
const payloadsOf = (rows: readonly RunEventRow[], type: string) =>
  rows.filter((row) => row.type === type).map((row) => row.payload);

describe("AGO-94 QA: model routing with AGO-166 run limits and the AGO-34 policy engine", () => {
  it("a loop ends the run, and every one of the 3 calls used the configured model only", async () => {
    const { loop, ctx, rows, created, calls, search } = setup({ storedModel: CONFIGURED });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 3, end: "loop_detected" });
    expect(created).toEqual([CONFIGURED]);
    expect(calls).toEqual([CONFIGURED, CONFIGURED, CONFIGURED]);
    expect(search.run).not.toHaveBeenCalled();
    expect(types(rows).at(-1)).toBe("run.loop_detected");
    const decisions = payloadsOf(rows, "policy.decision");
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision).toEqual(
        expect.objectContaining({ decision: "deny", reason_code: "not_granted" }),
      );
    }
  });

  it("a per-agent step limit below the loop threshold ends the run, still on the configured model", async () => {
    const { loop, ctx, rows, created, calls, search } = setup({
      storedModel: CONFIGURED,
      runLimits: { maxSteps: 2 },
    });

    const outcome = await loop.execute(ctx);

    expect(outcome).toEqual({ steps: 2, end: "limit_reached" });
    expect(created).toEqual([CONFIGURED]);
    expect(calls).toEqual([CONFIGURED, CONFIGURED]);
    expect(search.run).not.toHaveBeenCalled();
    expect(payloadsOf(rows, "run.limit_reached")).toEqual([
      expect.objectContaining({ limit: "steps", max: 2 }),
    ]);
    expect(types(rows)).not.toContain("run.loop_detected");
    expect(payloadsOf(rows, "policy.decision")).toHaveLength(2);
  });

  it.each([
    ["an unknown model", "gpt-4o"],
    ["an empty model", ""],
    ["a removed model", "claude-fable-5-0"],
  ])("%s fails the run before any model call, with no fallback model", async (_name, stored) => {
    const { loop, ctx, rows, created, calls, search } = setup({
      storedModel: stored,
      runLimits: { maxSteps: 2 },
    });

    const failure: unknown = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonRetryableRunError);
    expect((failure as NonRetryableRunError).reason).toBe(MODEL_ROUTING_REASON.modelNotAllowed);
    expect(created).toEqual([]);
    expect(calls).toEqual([]);
    expect(search.run).not.toHaveBeenCalled();
    expect(types(rows)).not.toContain("policy.decision");
  });

  it("a missing agent fails the run with agent_not_found and no model is built", async () => {
    const { loop, ctx, created, calls } = setup({ storedModel: null });

    const failure: unknown = await loop.execute(ctx).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonRetryableRunError);
    expect((failure as NonRetryableRunError).reason).toBe(MODEL_ROUTING_REASON.agentNotFound);
    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });
});
