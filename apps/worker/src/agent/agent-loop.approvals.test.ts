import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { approvalIdFor } from "../approvals/approval-id.js";
import {
  createMemoryApprovalStore,
  type MemoryApprovalStore,
} from "../approvals/approval-store.test-helpers.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { createAgentLoop } from "./agent-loop.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.test-helpers.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { CheckpointStore } from "./checkpoint-store.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";
import type { CapabilityTier } from "@ago/shared";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";
const T0 = Date.parse("2026-11-13T00:00:00Z");
const TTL_MS = 60_000;
const usage = { inputTokens: 10, outputTokens: 5 };

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function tool(name: string, tier: CapabilityTier): AgentTool & { run: ReturnType<typeof vi.fn> } {
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

const allowAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
};
const escalateAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "needs_approval", reasonCode: "human_required" }),
};
const denyAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "deny", reasonCode: "no" }),
};

function scriptedModel(calls: readonly string[]) {
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

/** One attempt of the run; the clock, the stores and the policy are the test's. */
function attempt(options: {
  provider: ModelProvider;
  tools: readonly AgentTool[];
  checkpoints: CheckpointStore;
  approvals: MemoryApprovalStore | undefined;
  policy: PolicyHook;
  clock: { now: number };
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

const types = (rows: readonly RunEventRow[]): string[] => rows.map((row) => row.type);
const failedCodes = (rows: readonly RunEventRow[]): unknown[] =>
  rows.filter((row) => row.type === "tool_call.failed").map((row) => row.payload.error_code);

/** Run the first attempt of a tier 3 call that pauses for approval, and hand back what a resume needs. */
async function pauseForApproval() {
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const clock = { now: T0 };
  const risky = tool("risky", 3);
  const first = attempt({
    provider: scriptedModel(["risky"]).provider,
    tools: [risky],
    checkpoints,
    approvals,
    policy: allowAll,
    clock,
  });
  const outcome = await first.loop.execute(first.ctx);
  const approvalId = approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" });
  return { checkpoints, approvals, clock, risky, first, outcome, approvalId };
}

/** A resumed attempt on the same stores. */
function resume(
  world: Awaited<ReturnType<typeof pauseForApproval>>,
  approvals: MemoryApprovalStore | undefined = world.approvals,
) {
  const model = scriptedModel(["risky"]);
  const next = attempt({
    provider: model.provider,
    tools: [world.risky],
    checkpoints: world.checkpoints,
    approvals,
    policy: allowAll,
    clock: world.clock,
  });
  return { ...next, model };
}

describe("AGO-21 AC1: an escalated call raises a pending approval and the run waits", () => {
  it("creates one pending approval bound to the call, emits the request with the same id, and pauses", async () => {
    const { approvals, risky, first, outcome, approvalId } = await pauseForApproval();

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(risky.run).not.toHaveBeenCalled();
    expect(approvals.all()).toHaveLength(1);
    const row = approvals.peek(approvalId);
    expect(row).toMatchObject({
      workspaceId: WS,
      runId: RUN,
      agentId: AGENT,
      action: "risky",
      status: "pending",
    });
    expect(row?.expiresAt.getTime()).toBe(T0 + TTL_MS);
    const requested = first.rows.find((r) => r.type === "approval.requested");
    expect(requested?.payload).toMatchObject({
      approval_id: approvalId,
      payload_hash: row?.payloadHash,
      expires_at: new Date(T0 + TTL_MS).toISOString(),
    });
  });

  it("raises one for a lower tier tool when the policy escalates it", async () => {
    const approvals = createMemoryApprovalStore();
    const a = attempt({
      provider: scriptedModel(["note"]).provider,
      tools: [tool("note", 2)],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: escalateAll,
      clock: { now: T0 },
    });

    expect(await a.loop.execute(a.ctx)).toMatchObject({ end: "paused" });
    expect(approvals.all()).toHaveLength(1);
  });

  it("does not store the tool input anywhere in the approval", async () => {
    const { approvals } = await pauseForApproval();
    const stored = JSON.stringify(approvals.all());
    expect(stored).not.toContain('"i"');
  });

  it("makes no second row when the same call is raised again (a retry)", async () => {
    const world = await pauseForApproval();
    // A crash before the checkpoint was saved: the retry starts the step over and meets the same call.
    await world.checkpoints.clear({ workspaceId: WS, runId: RUN });
    const again = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [world.risky],
      checkpoints: world.checkpoints,
      approvals: world.approvals,
      policy: allowAll,
      clock: world.clock,
    });

    expect(await again.loop.execute(again.ctx)).toMatchObject({ end: "paused" });

    expect(world.approvals.all()).toHaveLength(1);
  });

  it("does not run the tool when the approval cannot be stored", async () => {
    const approvals = createMemoryApprovalStore();
    approvals.create = () => Promise.reject(new Error("db down"));
    const risky = tool("risky", 3);
    const a = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [risky],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: allowAll,
      clock: { now: T0 },
    });

    await expect(a.loop.execute(a.ctx)).rejects.toThrow("db down");
    expect(risky.run).not.toHaveBeenCalled();
  });
});

describe("AGO-21 AC3: no approval exists for a Tier 0 or 1 call", () => {
  it("creates none for allowed tier 0 and tier 1 calls, which run", async () => {
    const approvals = createMemoryApprovalStore();
    const t0 = tool("clock", 0);
    const t1 = tool("read", 1);
    const a = attempt({
      provider: scriptedModel(["clock", "read"]).provider,
      tools: [t0, t1],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: allowAll,
      clock: { now: T0 },
    });

    expect(await a.loop.execute(a.ctx)).toMatchObject({ end: "completed" });

    expect(t0.run).toHaveBeenCalledTimes(1);
    expect(t1.run).toHaveBeenCalledTimes(1);
    expect(approvals.all()).toHaveLength(0);
    expect(types(a.rows)).not.toContain("approval.requested");
  });

  it("creates none for a denied call or an unknown tool", async () => {
    const approvals = createMemoryApprovalStore();
    const a = attempt({
      provider: scriptedModel(["read", "ghost"]).provider,
      tools: [tool("read", 1)],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: denyAll,
      clock: { now: T0 },
    });

    await a.loop.execute(a.ctx);

    expect(approvals.all()).toHaveLength(0);
  });
});

describe("AGO-21 AC2: an expired approval becomes rejected and the agent is told", () => {
  it("re-pauses a resumed call whose approval is still pending and not due, without a new request", async () => {
    const world = await pauseForApproval();
    world.clock.now = T0 + TTL_MS - 1;
    const b = resume(world);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(b.rows.filter((r) => r.type === "approval.requested")).toHaveLength(0);
    expect(failedCodes(b.rows)).toEqual([]);
    expect(b.model.requests).toHaveLength(0);
    expect(world.approvals.peek(world.approvalId)?.status).toBe("pending");
  });

  it("denies a resumed call whose approval is pending but past expires_at, even though no sweep ran", async () => {
    const world = await pauseForApproval();
    world.clock.now = T0 + TTL_MS; // exactly due
    const b = resume(world);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(world.approvalId)?.status).toBe("rejected");
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    const decided = b.rows.filter((r) => r.type === "approval.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({
      approval_id: world.approvalId,
      outcome: "expired",
      decided_by: "timeout",
      payload_hash: world.approvals.peek(world.approvalId)?.payloadHash,
    });
    // The agent is told: the model's next request carries the denial.
    expect(JSON.stringify(b.model.requests.at(-1)?.messages)).toContain(
      "expired before a human answered",
    );
  });

  it("closes a call the sweep already rejected, and writes no second decided event", async () => {
    const world = await pauseForApproval();
    world.approvals.setStatus(world.approvalId, "rejected");
    const b = resume(world);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(types(b.rows)).not.toContain("approval.decided");
  });
});

describe("AGO-21: the tool runs in no path that is not an approval it honours", () => {
  it("fails closed on an approved row until AGO-47 binds approvals to the payload hash", async () => {
    const world = await pauseForApproval();
    world.approvals.setStatus(world.approvalId, "approved");
    const b = resume(world);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
  });

  it("closes a denied approval as denied", async () => {
    const world = await pauseForApproval();
    world.approvals.setStatus(world.approvalId, "denied");
    const b = resume(world);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_denied"]);
  });

  it("denies when the approval row is missing", async () => {
    const world = await pauseForApproval();
    const b = resume(world, createMemoryApprovalStore());

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
  });

  it("denies when the stored approval is bound to a different payload", async () => {
    const world = await pauseForApproval();
    const other = createMemoryApprovalStore();
    await other.create({
      workspaceId: WS,
      runId: RUN,
      agentId: AGENT,
      approvalId: world.approvalId,
      action: "risky",
      payloadHash: "0".repeat(64),
      expiresAt: new Date(T0 + TTL_MS * 10),
    });
    const b = resume(world, other);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
  });

  it("denies when the approval lives in another workspace", async () => {
    const world = await pauseForApproval();
    const row = world.approvals.peek(world.approvalId);
    const other = createMemoryApprovalStore();
    await other.create({
      workspaceId: OTHER_WS,
      runId: RUN,
      agentId: AGENT,
      approvalId: world.approvalId,
      action: "risky",
      payloadHash: row?.payloadHash ?? "",
      expiresAt: new Date(T0 + TTL_MS * 10),
    });
    const b = resume(world, other);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
  });

  it("denies a resumed call when the loop has no approval store", async () => {
    const world = await pauseForApproval();
    const b = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [world.risky],
      checkpoints: world.checkpoints,
      approvals: undefined,
      policy: allowAll,
      clock: world.clock,
    });

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
  });
});
