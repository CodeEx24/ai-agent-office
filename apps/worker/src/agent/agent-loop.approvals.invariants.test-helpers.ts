// Shared harness for the AGO-21 human-in-the-loop invariant tests (functional tester). One attempt of a
// run through the real agent loop, with a scripted model, a fake clock and caller-chosen stores.
import { vi } from "vitest";
import { z } from "zod";

import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow, type RunEventStore } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ApprovalStore } from "../approvals/index.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";
import type { CapabilityTier } from "@ago/shared";

export const WS = "00000000-0000-4000-8000-000000000001";
export const OTHER_WS = "00000000-0000-4000-8000-000000000002";
export const AGENT = "00000000-0000-4000-8000-0000000000a1";
export const RUN = "00000000-0000-4000-8000-0000000000b1";
export const TASK = "00000000-0000-4000-8000-0000000000c1";
export const T0 = Date.parse("2026-11-13T00:00:00Z");
export const TTL_MS = 60_000;
const usage = { inputTokens: 10, outputTokens: 5 };

export type SpyTool = AgentTool & { run: ReturnType<typeof vi.fn> };

export function spyTool(name: string, tier: CapabilityTier): SpyTool {
  const run = vi.fn(() => Promise.resolve(`${name} output`));
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

export const allowAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
};
export const escalateAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "needs_approval", reasonCode: "human_required" }),
};
export const denyAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "deny", reasonCode: "no" }),
};

/** Calls every named tool once on the first request, then answers with text once it has seen a result. */
export function scriptedModel(calls: readonly string[]) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: (request) => {
      requests.push(request);
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      const response: ModelResponse = seenResult
        ? { text: "All done.", toolCalls: [], usage }
        : {
            text: "",
            toolCalls: calls.map((name, i) => ({ id: `toolu_${String(i)}`, name, input: { i } })),
            usage,
          };
      return Promise.resolve(response);
    },
  };
  return { provider, requests };
}

export interface AttemptOptions {
  readonly provider: ModelProvider;
  readonly tools: readonly AgentTool[];
  readonly checkpoints: CheckpointStore;
  readonly approvals: ApprovalStore | undefined;
  readonly policy: PolicyHook;
  readonly clock: { now: number };
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly agentId?: string;
  /** Where events also go (for example the real run_events table). They are always collected in `rows`. */
  readonly events?: RunEventStore;
}

/** One attempt of the run. The clock, the stores and the policy belong to the test. */
export function attempt(options: AttemptOptions) {
  const runId = options.runId ?? RUN;
  const workspaceId = options.workspaceId ?? WS;
  const agentId = options.agentId ?? AGENT;
  const rows: RunEventRow[] = [];
  const logger = createLogger({ level: "silent" });
  const emitter = createRunEventEmitter({
    workspaceId,
    runId,
    logger,
    store: {
      insert: (row) => {
        rows.push(row);
        return (
          options.events?.insert(row) ??
          Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" })
        );
      },
    },
  });
  const runContext = (): RunContext => ({
    runId,
    workspaceId,
    agent: { id: agentId, workspaceId, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId, title: "Find layouts", description: "Collect layouts." },
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
    tools: createToolRegistry(options.tools),
    policy: options.policy,
    checkpoints: options.checkpoints,
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    approvalTtlMs: TTL_MS,
    now: () => options.clock.now,
  });
  const ctx: RunExecutionContext = {
    workspaceId,
    runId,
    agentId,
    taskId: TASK,
    attempt: 0,
    logger,
    emitter,
    signal: new AbortController().signal,
  };
  return { loop, ctx, rows };
}

export const types = (rows: readonly RunEventRow[]): string[] => rows.map((row) => row.type);
export const failedCodes = (rows: readonly RunEventRow[]): unknown[] =>
  rows.filter((row) => row.type === "tool_call.failed").map((row) => row.payload.error_code);
export const decidedEvents = (rows: readonly RunEventRow[]): RunEventRow[] =>
  rows.filter((row) => row.type === "approval.decided");
