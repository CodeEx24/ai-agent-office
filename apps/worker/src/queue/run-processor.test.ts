import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.js";
import {
  createRunProcessor,
  NonRetryableRunError,
  type RunExecutor,
  type RunJob,
} from "./run-processor.js";
import { RUN_STATUS, type QueuedRun, type RunRef, type RunStore } from "./run-store.js";

import type { RunEventRow, RunEventStore } from "../events/index.js";
import type { ErrorTracker } from "../sentry.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

/** In-memory stand-in for the runs table, with the same claim semantics as the SQL. */
function fakeRunStore(initial: string = RUN_STATUS.queued) {
  const state = { status: initial };
  const store: RunStore = {
    findQueuedRun: () =>
      Promise.resolve(state.status === RUN_STATUS.queued ? { agentId: AGENT, taskId: null } : null),
    claimRun: (_ref: RunRef, options): Promise<QueuedRun | null> => {
      const claimable =
        state.status === RUN_STATUS.queued ||
        (options.allowStaleReclaim && state.status === RUN_STATUS.running);
      if (!claimable) return Promise.resolve(null);
      state.status = RUN_STATUS.running;
      return Promise.resolve({ agentId: AGENT, taskId: null });
    },
    releaseRun: () => {
      if (state.status === RUN_STATUS.running) state.status = RUN_STATUS.queued;
      return Promise.resolve();
    },
    markFinished: (_ref, status) => {
      state.status = status;
      return Promise.resolve();
    },
    markPaused: () => {
      if (state.status === RUN_STATUS.running) state.status = RUN_STATUS.paused;
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

function trackerSpy() {
  const captured: { error: unknown; context: unknown }[] = [];
  const tracker: ErrorTracker = {
    isEnabled: true,
    captureException: (error, context) => {
      captured.push({ error, context });
      return "evt";
    },
    addBreadcrumb: () => undefined,
    close: () => Promise.resolve(true),
  };
  return { captured, tracker };
}

const job = (overrides: Partial<RunJob> = {}): RunJob => ({
  id: "job-1",
  data: { workspace_id: WORKSPACE, run_id: RUN },
  retryCount: 0,
  signal: new AbortController().signal,
  ...overrides,
});

function setup(executor: RunExecutor, initialStatus?: string) {
  const runs = fakeRunStore(initialStatus);
  const events = fakeEvents();
  const tracking = trackerSpy();
  const process = createRunProcessor({
    runs: runs.store,
    events: events.store,
    executor,
    logger: createLogger({ level: "silent" }),
    errorTracker: tracking.tracker,
    retryLimit: 2,
    staleAfterSeconds: 900,
  });
  return { runs, events, tracking, process };
}

const eventTypes = (rows: readonly RunEventRow[]) => rows.map((row) => row.type);

describe("run processor", () => {
  it("claims the run, emits run.started and run.completed, and marks it succeeded", async () => {
    const execute = vi.fn<RunExecutor["execute"]>(() =>
      Promise.resolve({ steps: 3, summary: "ok" }),
    );
    const { runs, events, process } = setup({ execute });

    await expect(process(job())).resolves.toBe("executed");

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE,
      runId: RUN,
      agentId: AGENT,
      attempt: 0,
    });
    expect(eventTypes(events.rows)).toEqual(["run.started", "run.completed"]);
    expect(runs.state.status).toBe(RUN_STATUS.succeeded);
  });

  it("skips a duplicate job for a run that is already claimed or finished (AC1)", async () => {
    const execute = vi.fn(() => Promise.resolve({ steps: 0 }));
    const { events, process } = setup({ execute }, RUN_STATUS.running);

    await expect(process(job())).resolves.toBe("skipped_duplicate");

    expect(execute).not.toHaveBeenCalled();
    expect(events.rows).toHaveLength(0);
  });

  it("lets a retried job take back a run its dead worker left running", async () => {
    const execute = vi.fn(() => Promise.resolve({ steps: 1 }));
    const { runs, process } = setup({ execute }, RUN_STATUS.running);

    await expect(process(job({ retryCount: 1 }))).resolves.toBe("executed");
    expect(runs.state.status).toBe(RUN_STATUS.succeeded);
  });

  it("hands the run back for a retry when an attempt fails before the limit", async () => {
    const execute = vi.fn(() => Promise.reject(new Error("tool exploded")));
    const { runs, events, tracking, process } = setup({ execute });

    await expect(process(job({ retryCount: 1 }))).rejects.toThrow("tool exploded");

    expect(runs.state.status).toBe(RUN_STATUS.queued);
    expect(eventTypes(events.rows)).toEqual(["run.started"]);
    expect(tracking.captured).toHaveLength(0);
  });

  it("fails the run for good on the last attempt: run.failed event, failed status, Sentry with run_id", async () => {
    const execute = vi.fn(() => Promise.reject(new Error("tool exploded")));
    const { runs, events, tracking, process } = setup({ execute });

    await expect(process(job({ retryCount: 2 }))).rejects.toThrow("tool exploded");

    expect(runs.state.status).toBe(RUN_STATUS.failed);
    expect(eventTypes(events.rows)).toEqual(["run.started", "run.failed"]);
    expect(events.rows[1]?.payload).toMatchObject({
      reason: "retries_exhausted",
      message: "tool exploded",
    });
    expect(tracking.captured).toHaveLength(1);
    expect(tracking.captured[0]?.context).toMatchObject({
      run_id: RUN,
      workspace_id: WORKSPACE,
      agent_id: AGENT,
    });
  });

  it("scrubs secrets out of the stored failure message", async () => {
    const execute = vi.fn(() =>
      Promise.reject(new Error("connect postgres://user:hunter2@db.internal/app failed")),
    );
    const { events, process } = setup({ execute });

    await expect(process(job({ retryCount: 2 }))).rejects.toThrow();

    expect(JSON.stringify(events.rows)).not.toContain("hunter2");
  });

  it("ends a run that hit a limit as failed, with no run.completed (AGO-167)", async () => {
    const execute = vi.fn(() => Promise.resolve({ steps: 25, end: "limit_reached" as const }));
    const { runs, events, process } = setup({ execute });

    await expect(process(job())).resolves.toBe("executed");

    expect(eventTypes(events.rows)).toEqual(["run.started"]);
    expect(runs.state.status).toBe(RUN_STATUS.failed);
  });

  it("pauses a run that stopped for an approval instead of finishing it (AGO-167)", async () => {
    const execute = vi.fn(() => Promise.resolve({ steps: 2, end: "paused" as const }));
    const { runs, events, process } = setup({ execute });

    await expect(process(job())).resolves.toBe("executed");

    expect(eventTypes(events.rows)).toEqual(["run.started", "run.paused"]);
    expect(events.rows[1]?.payload).toMatchObject({
      requested_by: "policy",
      reason: "approval_required",
    });
    expect(runs.state.status).toBe(RUN_STATUS.paused);
  });

  it("fails a non-retryable error at once, with its reason, and spends no retries (AGO-167)", async () => {
    const execute = vi.fn(() => Promise.reject(new NonRetryableRunError("agent_archived", "gone")));
    const { runs, events, tracking, process } = setup({ execute });

    await expect(process(job({ retryCount: 0 }))).resolves.toBe("failed_permanently");

    expect(runs.state.status).toBe(RUN_STATUS.failed);
    expect(events.rows[1]?.payload).toMatchObject({ reason: "agent_archived" });
    expect(tracking.captured).toHaveLength(1);
  });

  it("rejects a malformed payload without echoing it and without touching the run", async () => {
    const execute = vi.fn(() => Promise.resolve({ steps: 0 }));
    const { runs, events, process } = setup({ execute });

    await expect(
      process(job({ data: { workspace_id: WORKSPACE, run_id: RUN, prompt: "do evil" } })),
    ).rejects.toThrow("invalid run job payload");

    expect(execute).not.toHaveBeenCalled();
    expect(events.rows).toHaveLength(0);
    expect(runs.state.status).toBe(RUN_STATUS.queued);
  });
});
