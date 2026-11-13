// AGO-21 functional tests: only a human can resume a run; the expiry wake-up is the one system path and it
// can only be reached through resumeAfterApprovalExpiry (it records resumed_by "timeout").
import { describe, expect, it, vi } from "vitest";

import { createMemoryCheckpointStore } from "../agent/checkpoint-store.test-helpers.js";
import { createLogger } from "../logger.js";
import { createRunControl, HumanActorRequiredError, type HumanActor } from "./run-control.js";

import type { RunEventRow } from "../events/index.js";
import type { RunStore } from "./run-store.js";

const REF = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
};

function setup() {
  const state = { status: "paused" };
  const runs: Pick<RunStore, "resumeRun" | "revertResume"> = {
    resumeRun: () => {
      const isPaused = state.status === "paused";
      if (isPaused) state.status = "queued";
      return Promise.resolve(isPaused);
    },
    revertResume: () => {
      state.status = "paused";
      return Promise.resolve();
    },
  };
  const rows: RunEventRow[] = [];
  const enqueue = vi.fn(() => Promise.resolve({ enqueued: true, jobId: "j" }));
  const control = createRunControl({
    runs,
    checkpoints: createMemoryCheckpointStore(),
    queue: { enqueueRun: enqueue },
    events: {
      insert: (row) => {
        rows.push(row);
        return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
      },
    },
    logger: createLogger({ level: "silent" }),
  });
  return { state, rows, enqueue, control };
}

describe("AGO-21: an agent can never resume a run", () => {
  it.each([
    ["an agent", { kind: "agent", agentId: "a1" }],
    ["the expiry timer", { kind: "timeout" }],
    ["a system actor", { kind: "system" }],
    ["a human lookalike with the wrong casing", { kind: "Human", userId: "u" }],
  ])("refuses %s and leaves the run paused with no event and no job", async (_name, actor) => {
    const { state, rows, enqueue, control } = setup();

    await expect(control.resumeRun(REF, actor as unknown as HumanActor)).rejects.toBeInstanceOf(
      HumanActorRequiredError,
    );

    expect(state.status).toBe("paused");
    expect(rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a missing actor and leaves the run paused", async () => {
    const { state, enqueue, control } = setup();

    await expect(control.resumeRun(REF, undefined as unknown as HumanActor)).rejects.toThrow();

    expect(state.status).toBe("paused");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not let an agent request a pause either", async () => {
    const { control } = setup();
    await expect(
      control.requestRunPause(REF, { kind: "agent" } as unknown as HumanActor),
    ).rejects.toBeInstanceOf(HumanActorRequiredError);
  });
});

describe("AGO-21: the expiry wake-up", () => {
  it("records resumed_by timeout and enqueues the run as a resume", async () => {
    const { rows, enqueue, control } = setup();

    await expect(control.resumeAfterApprovalExpiry(REF)).resolves.toBe("resumed");

    expect(rows.map((row) => row.type)).toEqual(["run.resumed"]);
    expect(rows[0]?.payload.resumed_by).toBe("timeout");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ isResume: true }));
  });

  it("wakes a run only once when two expiry wake-ups race", async () => {
    const { rows, enqueue, control } = setup();

    const results = await Promise.all([
      control.resumeAfterApprovalExpiry(REF),
      control.resumeAfterApprovalExpiry(REF),
    ]);

    expect([...results].sort()).toEqual(["not_paused", "resumed"]);
    expect(rows).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("puts the run back to paused when the job cannot be queued, so it is not left without a job", async () => {
    const { state, enqueue, control } = setup();
    enqueue.mockRejectedValueOnce(new Error("queue down"));

    await expect(control.resumeAfterApprovalExpiry(REF)).rejects.toThrow("queue down");

    expect(state.status).toBe("paused");
  });

  it("does not wake a run that is not paused", async () => {
    const { state, rows, enqueue, control } = setup();
    state.status = "running";

    await expect(control.resumeAfterApprovalExpiry(REF)).resolves.toBe("not_paused");

    expect(rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
