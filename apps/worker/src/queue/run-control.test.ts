import { describe, expect, it, vi } from "vitest";

import {
  createMemoryCheckpointStore,
  type MemoryCheckpointStore,
} from "../agent/checkpoint-store.test-helpers.js";
import {
  approvalIdOf,
  awaitingApprovalState,
} from "../approvals/awaiting-checkpoint.test-helpers.js";
import { createLogger } from "../logger.js";
import { createRunControl, HumanActorRequiredError, type HumanActor } from "./run-control.js";
import { createRunProcessor, type RunExecutor } from "./run-processor.js";
import { RUN_STATUS, type QueuedRun, type RunStore } from "./run-store.js";

import type { RunEventRow, RunEventStore } from "../events/index.js";
import type { ErrorTracker } from "../sentry.js";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const REF = { workspaceId: WS, runId: RUN };
const HUMAN: HumanActor = { kind: "human", userId: "44444444-4444-4444-8444-444444444444" };

function fakeRunStore(initial: string, checkpoints?: MemoryCheckpointStore) {
  const state = { status: initial };
  const store: RunStore = {
    findQueuedRun: () =>
      Promise.resolve(state.status === RUN_STATUS.queued ? { agentId: AGENT, taskId: null } : null),
    claimRun: (): Promise<QueuedRun | null> => {
      if (state.status !== RUN_STATUS.queued) return Promise.resolve(null);
      state.status = RUN_STATUS.running;
      return Promise.resolve({ agentId: AGENT, taskId: null });
    },
    releaseRun: () => Promise.resolve(),
    markFinished: (_ref, status) => {
      state.status = status;
      return Promise.resolve();
    },
    markPaused: () => {
      if (state.status === RUN_STATUS.running) state.status = RUN_STATUS.paused;
      return Promise.resolve();
    },
    resumeRun: () => {
      const isPaused = state.status === RUN_STATUS.paused;
      if (isPaused) state.status = RUN_STATUS.queued;
      return Promise.resolve(isPaused);
    },
    // Like the SQL: status and pause flag are read and the move made in one synchronous step.
    wakeRunAfterExpiry: () => {
      const canWake =
        state.status === RUN_STATUS.paused && checkpoints?.isPauseRequestedNow(REF) !== true;
      if (canWake) state.status = RUN_STATUS.queued;
      return Promise.resolve(canWake);
    },
    markStopped: (_ref, from) => {
      const canStop = (from as readonly string[]).includes(state.status);
      if (canStop) state.status = RUN_STATUS.stopped;
      return Promise.resolve(canStop);
    },
    revertResume: () => {
      if (state.status === RUN_STATUS.queued) state.status = RUN_STATUS.paused;
      return Promise.resolve();
    },
  };
  return { state, store };
}

function fakeEvents() {
  const rows: RunEventRow[] = [];
  const store: RunEventStore = {
    insert: (row) => {
      rows.push(row);
      return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
    },
  };
  return { rows, store };
}

function setup(
  initial: string,
  enqueue = vi.fn(() => Promise.resolve({ enqueued: true, jobId: "j" })),
) {
  const checkpoints = createMemoryCheckpointStore();
  const runs = fakeRunStore(initial, checkpoints);
  const events = fakeEvents();
  const control = createRunControl({
    runs: runs.store,
    checkpoints,
    queue: { enqueueRun: enqueue },
    events: events.store,
    logger: createLogger({ level: "silent" }),
  });
  return { runs, events, checkpoints, control, enqueue };
}

describe("run control: wake after an approval expired (AGO-21)", () => {
  const EXPIRED = { ...REF, approvalId: approvalIdOf({ runId: RUN }) };

  it("moves a paused run waiting on that approval to queued, records resumed_by timeout and enqueues it", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({}));

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("resumed");

    expect(runs.state.status).toBe(RUN_STATUS.queued);
    expect(events.rows[0]?.payload).toMatchObject({ resumed_by: "timeout" });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN, isResume: true }));
  });

  it("does nothing for a run that is not paused", async () => {
    const { events, checkpoints, control, enqueue } = setup(RUN_STATUS.running);
    await checkpoints.save(REF, awaitingApprovalState({}));

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("not_paused");

    expect(enqueue).not.toHaveBeenCalled();
    expect(events.rows).toHaveLength(0);
  });

  it("does not wake a human-paused run, keeps their pause request, and their resume closes the call", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({}));
    await checkpoints.requestPause(REF);

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("human_paused");

    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(events.rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await checkpoints.isPauseRequested(REF)).toBe(true);

    // The human resumes: that is the only thing that clears their request and wakes the run.
    await expect(control.resumeRun(REF, HUMAN)).resolves.toBe("resumed");
    expect(await checkpoints.isPauseRequested(REF)).toBe(false);
    expect(events.rows[0]?.payload).toMatchObject({ resumed_by: "human" });
  });

  // AGO-58 (must-fix from AGO-21): the pause flag is checked INSIDE the one conditional update that moves the run.
  it("does not override a human pause that lands after the checkpoint was read (the old check-then-move window)", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({}));
    // The human's pause arrives right after the wake loaded the checkpoint, before it moves the run.
    const load = checkpoints.load.bind(checkpoints);
    vi.spyOn(checkpoints, "load").mockImplementation(async (ref) => {
      const loaded = await load(ref);
      await checkpoints.requestPause(ref);
      return loaded;
    });

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("human_paused");

    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(events.rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await checkpoints.isPauseRequested(REF)).toBe(true);
  });

  it("two concurrent wakes: exactly one transition, one event, one job", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({}));

    const results = await Promise.all([
      control.resumeAfterApprovalExpiry(EXPIRED),
      control.resumeAfterApprovalExpiry(EXPIRED),
    ]);

    expect([...results].sort()).toEqual(["not_paused", "resumed"]);
    expect(runs.state.status).toBe(RUN_STATUS.queued);
    expect(events.rows).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("two concurrent wakes against a human pause: neither moves the run", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({}));
    await checkpoints.requestPause(REF);

    const results = await Promise.all([
      control.resumeAfterApprovalExpiry(EXPIRED),
      control.resumeAfterApprovalExpiry(EXPIRED),
    ]);

    expect(results).toEqual(["human_paused", "human_paused"]);
    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(events.rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not wake a run that is waiting on a different approval", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);
    await checkpoints.save(REF, awaitingApprovalState({ callId: "toolu_other" }));

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("not_waiting");

    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(events.rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not wake a run whose approval is for another step, or that has no checkpoint", async () => {
    const { runs, events, checkpoints, control, enqueue } = setup(RUN_STATUS.paused);

    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("not_waiting");
    await checkpoints.save(REF, awaitingApprovalState({ step: 2 }));
    await expect(control.resumeAfterApprovalExpiry(EXPIRED)).resolves.toBe("not_waiting");

    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(events.rows).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still refuses a non-human actor for the ordinary resume", async () => {
    const { control } = setup(RUN_STATUS.paused);
    await expect(
      control.resumeRun(REF, { kind: "agent", userId: "x" } as unknown as HumanActor),
    ).rejects.toThrow();
  });
});

describe("run control: resume", () => {
  it("moves a paused run to queued, records a human resume and enqueues it as a resume", async () => {
    const { runs, events, control, enqueue } = setup(RUN_STATUS.paused);

    await expect(control.resumeRun(REF, HUMAN)).resolves.toBe("resumed");

    expect(runs.state.status).toBe(RUN_STATUS.queued);
    expect(events.rows.map((r) => r.type)).toEqual(["run.resumed"]);
    expect(events.rows[0]?.payload).toMatchObject({ resumed_by: "human" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, runId: RUN, isResume: true }),
    );
  });

  it("is idempotent: a second resume does nothing", async () => {
    const { control, enqueue, events } = setup(RUN_STATUS.paused);

    await control.resumeRun(REF, HUMAN);
    await expect(control.resumeRun(REF, HUMAN)).resolves.toBe("not_paused");

    expect(enqueue).toHaveBeenCalledOnce();
    expect(events.rows).toHaveLength(1);
  });

  it.each([RUN_STATUS.queued, RUN_STATUS.running, RUN_STATUS.succeeded, RUN_STATUS.failed])(
    "does nothing for a run that is %s",
    async (status) => {
      const { runs, control, enqueue, events } = setup(status);

      await expect(control.resumeRun(REF, HUMAN)).resolves.toBe("not_paused");

      expect(runs.state.status).toBe(status);
      expect(enqueue).not.toHaveBeenCalled();
      expect(events.rows).toHaveLength(0);
    },
  );

  it("puts the run back to paused when the job cannot be enqueued", async () => {
    const enqueue = vi.fn(() => Promise.reject(new Error("queue down")));
    const { runs, control } = setup(RUN_STATUS.paused, enqueue);

    await expect(control.resumeRun(REF, HUMAN)).rejects.toThrow("queue down");

    expect(runs.state.status).toBe(RUN_STATUS.paused);
  });

  it("refuses anything that is not a human, before touching the run (an agent can never resume)", async () => {
    const { runs, control, enqueue } = setup(RUN_STATUS.paused);
    const agent = { kind: "agent", userId: "x" } as unknown as HumanActor;

    await expect(control.resumeRun(REF, agent)).rejects.toBeInstanceOf(HumanActorRequiredError);
    await expect(control.requestRunPause(REF, agent)).rejects.toBeInstanceOf(
      HumanActorRequiredError,
    );

    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("run control: pause request", () => {
  it("records the request for the loop to see at its next safe point", async () => {
    const { control, checkpoints } = setup(RUN_STATUS.running);

    await expect(control.requestRunPause(REF, HUMAN)).resolves.toBe(true);

    await expect(checkpoints.isPauseRequested(REF)).resolves.toBe(true);
  });
});

describe("run processor: pause reason and checkpoint cleanup (AGO-30)", () => {
  function processorSetup(executor: RunExecutor) {
    const runs = fakeRunStore(RUN_STATUS.queued);
    const events = fakeEvents();
    const checkpoints = createMemoryCheckpointStore();
    const clear = vi.spyOn(checkpoints, "clear");
    const tracker: ErrorTracker = {
      isEnabled: true,
      captureException: () => "evt",
      addBreadcrumb: () => undefined,
      close: () => Promise.resolve(true),
    };
    const process = createRunProcessor({
      runs: runs.store,
      events: events.store,
      executor,
      logger: createLogger({ level: "silent" }),
      errorTracker: tracker,
      checkpoints,
      retryLimit: 2,
      staleAfterSeconds: 900,
    });
    const job = {
      id: "job-1",
      data: { workspace_id: WS, run_id: RUN },
      retryCount: 0,
      signal: new AbortController().signal,
    };
    return { runs, events, clear, process, job };
  }

  it("records a human pause as requested by a human and keeps the checkpoint", async () => {
    const { runs, events, clear, process, job } = processorSetup({
      execute: () => Promise.resolve({ steps: 1, end: "paused", pauseReason: "user_pause" }),
    });

    await process(job);

    expect(events.rows.map((r) => r.type)).toEqual(["run.started", "run.paused"]);
    expect(events.rows[1]?.payload).toMatchObject({ requested_by: "human", reason: "user_pause" });
    expect(runs.state.status).toBe(RUN_STATUS.paused);
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps an approval pause as a policy pause", async () => {
    const { events, process, job } = processorSetup({
      execute: () => Promise.resolve({ steps: 1, end: "paused" }),
    });

    await process(job);

    expect(events.rows[1]?.payload).toMatchObject({
      requested_by: "policy",
      reason: "approval_required",
    });
  });

  it("drops the checkpoint when the run completes", async () => {
    const { clear, process, job } = processorSetup({
      execute: () => Promise.resolve({ steps: 1 }),
    });

    await process(job);

    expect(clear).toHaveBeenCalledOnce();
  });

  it("drops the checkpoint when a run is stopped at a limit", async () => {
    const { clear, process, job } = processorSetup({
      execute: () => Promise.resolve({ steps: 1, end: "limit_reached" }),
    });

    await process(job);

    expect(clear).toHaveBeenCalledOnce();
  });
});
