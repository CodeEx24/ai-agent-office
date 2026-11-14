import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import {
  createMemoryCheckpointStore,
  type MemoryCheckpointStore,
} from "./checkpoint-store.test-helpers.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ModelProvider, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";

// AGO-86: the human control flag is read before every tool call, ahead of the policy hook and the tool.

const WS = "86000000-0000-4000-8000-000000000001";
const AGENT = "86000000-0000-4000-8000-0000000000a1";
const RUN = "86000000-0000-4000-8000-0000000000b1";
const TASK = "86000000-0000-4000-8000-0000000000c1";
const REF = { workspaceId: WS, runId: RUN };
const usage = { inputTokens: 10, outputTokens: 5 };

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function world(options: { onToolRun?: (name: string) => void } = {}) {
  const log: string[] = [];
  const checkpoints = createMemoryCheckpointStore();
  checkpoints.onControlRead(() => {
    log.push("control");
    return Promise.resolve();
  });
  const makeTool = (name: string): AgentTool & { run: ReturnType<typeof vi.fn> } => {
    const run = vi.fn(() => {
      log.push(`tool:${name}`);
      options.onToolRun?.(name);
      return Promise.resolve(`${name} output`);
    });
    return {
      name,
      description: `${name} tool`,
      tier: 1,
      inputSchema: z.looseObject({}),
      modelInputSchema: { type: "object" },
      execute: run,
      run,
    };
  };
  const tools = ["a", "b", "c"].map(makeTool);
  const policy: PolicyHook = {
    check: (request) => {
      log.push(`policy:${request.toolName}`);
      return Promise.resolve({ decision: "allow", reasonCode: "test_allow" });
    },
  };
  const provider: ModelProvider = {
    complete: (request) => {
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      const response: ModelResponse = seenResult
        ? { text: "All done.", toolCalls: [], usage }
        : {
            text: "",
            toolCalls: ["a", "b", "c"].map((name, i) => ({
              id: `toolu_${String(i)}`,
              name,
              input: { i },
            })),
            usage,
          };
      return Promise.resolve(response);
    },
  };

  function attempt() {
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
      tools: createToolRegistry(tools),
      policy,
      checkpoints,
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
    return { loop, ctx, rows };
  }
  return { log, checkpoints, tools, attempt };
}

const types = (rows: readonly RunEventRow[]): string[] => rows.map((row) => row.type);
const toolRuns = (log: readonly string[]): string[] => log.filter((e) => e.startsWith("tool:"));

describe("AGO-86 AC1: the control flag is checked before every tool call", () => {
  it("reads it right before each call, then asks the policy, then runs the tool (control, policy, tool)", async () => {
    const w = world();
    const { loop, ctx } = w.attempt();
    expect(await loop.execute(ctx)).toMatchObject({ end: "completed" });
    for (const name of ["a", "b", "c"]) {
      const at = w.log.indexOf(`policy:${name}`);
      expect(w.log[at - 1]).toBe("control");
      expect(w.log[at + 1]).toBe(`tool:${name}`);
    }
  });

  it("starts no policy hook, no event and no tool when a stop is already requested", async () => {
    const w = world();
    w.checkpoints.flagStop(REF);
    const { loop, ctx, rows } = w.attempt();
    expect(await loop.execute(ctx)).toMatchObject({ end: "stopped" });
    expect(w.log.filter((entry) => entry !== "control")).toEqual([]);
    expect(types(rows)).not.toContain("tool_call.requested");
  });

  it("fails closed: a flag that cannot be read fails the attempt and no tool runs", async () => {
    const w = world();
    w.checkpoints.failControlReads();
    const { loop, ctx } = w.attempt();
    await expect(loop.execute(ctx)).rejects.toThrow();
    expect(w.tools.every((t) => t.run.mock.calls.length === 0)).toBe(true);
  });
});

describe("AGO-86 AC3: a paused agent makes no further calls within one tool-call boundary", () => {
  it("a pause that arrives while a tool runs lets that call finish and starts none after it", async () => {
    const holder: { store?: MemoryCheckpointStore } = {};
    const w = world({
      onToolRun: (name) => {
        if (name === "a") holder.store?.flagPause(REF);
      },
    });
    holder.store = w.checkpoints;
    const { loop, ctx } = w.attempt();

    const outcome = await loop.execute(ctx);

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "user_pause" });
    expect(toolRuns(w.log)).toEqual(["tool:a"]);
    expect(w.log).not.toContain("policy:b");
  });

  it("a pause that lands in the window before a call's control read lets at most that call run", async () => {
    const w = world();
    let reads = 0;
    w.checkpoints.onControlRead(() => {
      reads += 1;
      if (reads === 3) w.checkpoints.flagPause(REF);
      return Promise.resolve();
    });
    const { loop, ctx } = w.attempt();

    expect(await loop.execute(ctx)).toMatchObject({ end: "paused" });
    expect(toolRuns(w.log).length).toBeLessThanOrEqual(1);
  });

  it("resumes where it stopped: the finished call is not run again, the rest are", async () => {
    const holder: { store?: MemoryCheckpointStore } = {};
    const w = world({
      onToolRun: (name) => {
        if (name === "a") holder.store?.flagPause(REF);
      },
    });
    holder.store = w.checkpoints;
    const first = w.attempt();
    await first.loop.execute(first.ctx);

    await w.checkpoints.clearPause(REF);
    const second = w.attempt();
    expect(await second.loop.execute(second.ctx)).toMatchObject({ end: "completed" });

    expect(w.tools.map((t) => t.run.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe("AGO-86: stop", () => {
  it("a stop that arrives mid-step ends the run as stopped, runs nothing after it and writes no terminal event itself", async () => {
    const holder: { store?: MemoryCheckpointStore } = {};
    const w = world({
      onToolRun: (name) => {
        if (name === "a") holder.store?.flagStop(REF);
      },
    });
    holder.store = w.checkpoints;
    const { loop, ctx, rows } = w.attempt();

    expect(await loop.execute(ctx)).toMatchObject({ end: "stopped" });

    expect(toolRuns(w.log)).toEqual(["tool:a"]);
    expect(types(rows)).not.toContain("run.completed");
    expect(types(rows)).not.toContain("run.stopped");
  });

  it("a stop wins over a pause", async () => {
    const w = world();
    w.checkpoints.flagPause(REF);
    w.checkpoints.flagStop(REF);
    const { loop, ctx } = w.attempt();
    expect(await loop.execute(ctx)).toMatchObject({ end: "stopped" });
  });
});
