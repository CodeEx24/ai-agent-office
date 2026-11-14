import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createMemoryCheckpointStore } from "../agent/checkpoint-store.test-helpers.js";
import { createMemoryApprovalStore } from "../approvals/approval-store.test-helpers.js";
import { createLogger } from "../logger.js";
import { sweepControlRequests } from "./run-control-sweep.js";
import { finalizeStop, STOP_REASON } from "./run-stop.js";
import { RUN_STATUS } from "./run-store.js";

import type { RunEventRow, RunEventStore } from "../events/index.js";
import type { RunControl } from "./run-control.js";

// AGO-86: a stop is final and closes the run's approvals; a resume never outranks a stop.

const WS = "86000000-0000-4000-8000-000000000001";
const OTHER_WS = "86000000-0000-4000-8000-000000000002";
const AGENT = "86000000-0000-4000-8000-0000000000a1";
const RUN = "86000000-0000-4000-8000-0000000000b1";
const REF = { workspaceId: WS, runId: RUN };
const HUMAN = "86000000-0000-4000-8000-0000000000d1";

function world(initialStatus: string) {
  const state = { status: initialStatus };
  const runs = {
    markStopped: vi.fn((_ref: unknown, from: readonly string[]) => {
      const canStop = from.includes(state.status);
      if (canStop) state.status = RUN_STATUS.stopped;
      return Promise.resolve(canStop);
    }),
  };
  const rows: RunEventRow[] = [];
  const events: RunEventStore = {
    insert: (row) => {
      rows.push(row);
      return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
    },
  };
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const control = {
    resumeRun: vi.fn(() => Promise.resolve("resumed" as const)),
  } satisfies Pick<RunControl, "resumeRun">;
  const logger = createLogger({ level: "silent" });
  const deps = { runs, approvals, checkpoints, events, control, logger };
  return { state, runs, rows, checkpoints, approvals, control, deps };
}

async function pendingApproval(w: ReturnType<typeof world>, id: string, workspaceId = WS) {
  await w.approvals.create({
    approvalId: id,
    workspaceId,
    runId: RUN,
    agentId: AGENT,
    action: "risky",
    payloadHash: createHash("sha256").update(id).digest("hex"),
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
}

const types = (rows: readonly RunEventRow[]): string[] => rows.map((row) => row.type);

describe("AGO-86: finalizeStop", () => {
  it("moves the run to stopped, writes run.stopped once, and drops the checkpoint", async () => {
    const w = world(RUN_STATUS.paused);
    w.checkpoints.flagStop(REF);

    expect(await finalizeStop(w.deps, REF, ["queued", "paused"])).toBe(true);

    expect(w.state.status).toBe(RUN_STATUS.stopped);
    const stopped = w.rows.filter((r) => r.type === "run.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toMatchObject({ stopped_by: "human", reason: STOP_REASON });
    expect(w.checkpoints.peek(REF)).toBeNull();
    expect(w.checkpoints.isStopRequestedNow(REF)).toBe(false);
  });

  it("is final: a second stop moves nothing and writes nothing", async () => {
    const w = world(RUN_STATUS.paused);
    expect(await finalizeStop(w.deps, REF, ["queued", "paused"])).toBe(true);
    const before = w.rows.length;

    expect(await finalizeStop(w.deps, REF, ["queued", "paused"])).toBe(false);

    expect(w.rows).toHaveLength(before);
  });

  it("does not stop a run that already finished", async () => {
    const w = world(RUN_STATUS.succeeded);
    expect(await finalizeStop(w.deps, REF, ["queued", "paused"])).toBe(false);
    expect(w.state.status).toBe(RUN_STATUS.succeeded);
    expect(types(w.rows)).not.toContain("run.stopped");
  });

  it("closes the run's pending approvals as rejected (never approved) with a denied event each", async () => {
    const w = world(RUN_STATUS.paused);
    await pendingApproval(w, "86000000-0000-4000-8000-0000000000e1");
    await pendingApproval(w, "86000000-0000-4000-8000-0000000000e2");

    await finalizeStop(w.deps, REF, ["paused"]);

    expect(w.approvals.all().map((a) => a.status)).toEqual(["rejected", "rejected"]);
    const decided = w.rows.filter((r) => r.type === "approval.decided");
    expect(decided).toHaveLength(2);
    for (const row of decided) {
      expect(row.payload).toMatchObject({ outcome: "denied", decided_by: "human" });
    }
  });

  it("leaves an approval of another workspace alone", async () => {
    const w = world(RUN_STATUS.paused);
    await pendingApproval(w, "86000000-0000-4000-8000-0000000000e3", OTHER_WS);

    await finalizeStop(w.deps, REF, ["paused"]);

    expect(w.approvals.peek("86000000-0000-4000-8000-0000000000e3")?.status).toBe("pending");
  });
});

describe("AGO-86: the control sweep", () => {
  it("stops a paused run that has a stop request", async () => {
    const w = world(RUN_STATUS.paused);
    w.checkpoints.flagStop(REF, HUMAN);

    expect(await sweepControlRequests(w.deps)).toBe(1);

    expect(w.state.status).toBe(RUN_STATUS.stopped);
  });

  it("leaves a running run to its own loop: it is not stopped by the sweep", async () => {
    const w = world(RUN_STATUS.running);
    w.checkpoints.flagStop(REF, HUMAN);

    expect(await sweepControlRequests(w.deps)).toBe(0);

    expect(w.state.status).toBe(RUN_STATUS.running);
    expect(w.checkpoints.isStopRequestedNow(REF)).toBe(true);
    expect(types(w.rows)).not.toContain("run.stopped");
  });

  it("a stop beats a resume: a run with both is stopped and never resumed", async () => {
    const w = world(RUN_STATUS.paused);
    w.checkpoints.flagResume(REF, HUMAN);
    w.checkpoints.flagStop(REF, HUMAN);

    await sweepControlRequests(w.deps);

    expect(w.control.resumeRun).not.toHaveBeenCalled();
    expect(w.state.status).toBe(RUN_STATUS.stopped);
  });

  it("resumes a paused run as the person who asked, then forgets the request", async () => {
    const w = world(RUN_STATUS.paused);
    w.checkpoints.flagResume(REF, HUMAN);

    expect(await sweepControlRequests(w.deps)).toBe(1);

    expect(w.control.resumeRun).toHaveBeenCalledWith(REF, { kind: "human", userId: HUMAN });
    expect(w.checkpoints.isResumeRequestedNow(REF)).toBe(false);
  });

  it("never resumes a request that names no person, and forgets it", async () => {
    const w = world(RUN_STATUS.paused);
    w.checkpoints.flagResume(REF, null);

    expect(await sweepControlRequests(w.deps)).toBe(0);

    expect(w.control.resumeRun).not.toHaveBeenCalled();
    expect(w.checkpoints.isResumeRequestedNow(REF)).toBe(false);
  });

  it("a resume does not touch approvals: they stay pending for the woken loop to read", async () => {
    const w = world(RUN_STATUS.paused);
    await pendingApproval(w, "86000000-0000-4000-8000-0000000000e4");
    w.checkpoints.flagResume(REF, HUMAN);

    await sweepControlRequests(w.deps);

    expect(w.approvals.peek("86000000-0000-4000-8000-0000000000e4")?.status).toBe("pending");
    expect(types(w.rows)).not.toContain("approval.decided");
  });

  it("one failing run does not stop the others, and the failure is reported", async () => {
    const w = world(RUN_STATUS.paused);
    const OTHER_RUN = "86000000-0000-4000-8000-0000000000b2";
    w.checkpoints.flagResume({ workspaceId: WS, runId: OTHER_RUN }, HUMAN);
    w.checkpoints.flagResume(REF, HUMAN);
    w.control.resumeRun.mockRejectedValueOnce(new Error("db down"));
    const onError = vi.fn();

    await sweepControlRequests({ ...w.deps, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(w.control.resumeRun).toHaveBeenCalledTimes(2);
  });
});
