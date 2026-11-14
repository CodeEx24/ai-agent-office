import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { approvalIdFor } from "../approvals/approval-id.js";
import { createMemoryApprovalStore } from "../approvals/approval-store.test-helpers.js";
import { createContextBuilder, type RunContext } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow, type RunEventStore } from "../events/index.js";
import { createLogger } from "../logger.js";
import { type RunExecutionContext } from "../queue/run-processor.js";
import { finalizeStop } from "../queue/run-stop.js";
import { createAgentLoop } from "./agent-loop.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.test-helpers.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ModelProvider, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";

// AGO-86 functional acceptance (tester): the real loop with the real approval path and the real stop finalizer.
// Resume must not bypass a pending approval; a stop must beat an approval that was already granted; a stop closes
// pending approvals as denied. In-memory stores only: no database, no model.

const WS = "86000000-0000-4000-8000-000000000001";
const AGENT = "86000000-0000-4000-8000-0000000000a1";
const RUN = "86000000-0000-4000-8000-0000000000b1";
const TASK = "86000000-0000-4000-8000-0000000000c1";
const REF = { workspaceId: WS, runId: RUN };
const T0 = Date.parse("2026-11-14T00:00:00Z");
const usage = { inputTokens: 10, outputTokens: 5 };
const APPROVAL_ID = approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" });

function runContext(): RunContext {
  return {
    runId: RUN,
    workspaceId: WS,
    agent: { id: AGENT, workspaceId: WS, name: "Scout", role: "Researches.", prompt: null },
    task: { id: TASK, workspaceId: WS, title: "Find layouts", description: "Collect layouts." },
  };
}

function world() {
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const rows: RunEventRow[] = [];
  const events: RunEventStore = {
    insert: (row) => {
      rows.push(row);
      return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
    },
  };
  const run = vi.fn(() => Promise.resolve("risky output"));
  const risky: AgentTool = {
    name: "risky",
    description: "a tier 3 tool",
    tier: 3,
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
  };
  const policy: PolicyHook = {
    check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
  };
  const provider: ModelProvider = {
    complete: (request) => {
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      const response: ModelResponse = seenResult
        ? { text: "All done.", toolCalls: [], usage }
        : {
            text: "",
            toolCalls: [{ id: "toolu_0", name: "risky", input: { i: 0 } }],
            usage,
          };
      return Promise.resolve(response);
    },
  };
  const logger = createLogger({ level: "silent" });

  function attempt() {
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, logger, store: events });
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
      tools: createToolRegistry([risky]),
      policy,
      checkpoints,
      approvals,
      approvalTtlMs: 60_000,
      now: () => T0,
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
    return { loop, ctx };
  }
  return { checkpoints, approvals, rows, events, run, logger, attempt };
}

const types = (rows: readonly RunEventRow[]): string[] => rows.map((row) => row.type);

describe("AGO-86: resume does not bypass a pending approval", () => {
  it("a resumed run whose approval is still pending pauses again and never runs the tool", async () => {
    const w = world();
    const first = w.attempt();
    expect(await first.loop.execute(first.ctx)).toMatchObject({
      end: "paused",
      pauseReason: "approval_required",
    });
    expect(w.approvals.peek(APPROVAL_ID)?.status).toBe("pending");

    // A person resumes: the run is picked up again, with no pause flag and no stop flag.
    const second = w.attempt();
    expect(await second.loop.execute(second.ctx)).toMatchObject({
      end: "paused",
      pauseReason: "approval_required",
    });

    expect(w.run).not.toHaveBeenCalled();
    expect(w.approvals.all()).toHaveLength(1);
    expect(w.approvals.peek(APPROVAL_ID)?.status).toBe("pending");
  });
});

describe("AGO-86: a stop beats everything, including a granted approval", () => {
  it("an approved call waiting to run is NOT run once a stop is requested", async () => {
    const w = world();
    const first = w.attempt();
    await first.loop.execute(first.ctx);
    w.approvals.setStatus(APPROVAL_ID, "approved"); // a person approved it
    w.checkpoints.flagStop(REF); // then a person stopped the run

    const second = w.attempt();
    expect(await second.loop.execute(second.ctx)).toMatchObject({ end: "stopped" });

    expect(w.run).not.toHaveBeenCalled();
    expect(w.approvals.peek(APPROVAL_ID)?.consumedAt).toBeNull();
  });

  it("an approved call waiting to run is NOT run while a pause is requested either", async () => {
    const w = world();
    const first = w.attempt();
    await first.loop.execute(first.ctx);
    w.approvals.setStatus(APPROVAL_ID, "approved");
    w.checkpoints.flagPause(REF);

    const second = w.attempt();
    expect(await second.loop.execute(second.ctx)).toMatchObject({
      end: "paused",
      pauseReason: "user_pause",
    });

    expect(w.run).not.toHaveBeenCalled();
    expect(w.approvals.peek(APPROVAL_ID)?.consumedAt).toBeNull();
  });

  it("with no flag, the same approved call does run (the check is the only thing that held it)", async () => {
    const w = world();
    const first = w.attempt();
    await first.loop.execute(first.ctx);
    w.approvals.setStatus(APPROVAL_ID, "approved");

    const second = w.attempt();
    expect(await second.loop.execute(second.ctx)).toMatchObject({ end: "completed" });

    expect(w.run).toHaveBeenCalledTimes(1);
  });
});

describe("AGO-86: stop closes pending approvals as denied", () => {
  it("a paused-for-approval run that is stopped has its approval rejected and a denied event, then run.stopped", async () => {
    const w = world();
    const first = w.attempt();
    await first.loop.execute(first.ctx);
    const status = { value: "paused" };
    const runs = {
      markStopped: vi.fn((_ref: unknown, from: readonly string[]) => {
        const canStop = from.includes(status.value);
        if (canStop) status.value = "stopped";
        return Promise.resolve(canStop);
      }),
    };

    const moved = await finalizeStop(
      {
        runs,
        approvals: w.approvals,
        checkpoints: w.checkpoints,
        events: w.events,
        logger: w.logger,
      },
      REF,
      ["queued", "paused"],
    );

    expect(moved).toBe(true);
    expect(w.approvals.peek(APPROVAL_ID)?.status).toBe("rejected");
    // In order: requested, then the denial of it, then the stop. Other events (step.completed) may sit between.
    const order = types(w.rows).filter((type) =>
      ["approval.requested", "approval.decided", "run.stopped"].includes(type),
    );
    expect(order).toEqual(["approval.requested", "approval.decided", "run.stopped"]);
    const decided = w.rows.find((r) => r.type === "approval.decided");
    expect(decided?.payload).toMatchObject({
      approval_id: APPROVAL_ID,
      outcome: "denied",
      decided_by: "human",
    });
    // the runtime never writes approved to the approvals row itself
    expect(w.approvals.all().map((a) => a.status)).not.toContain("approved");
  });
});
