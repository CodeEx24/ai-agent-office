// Queue-level fail-closed check (AGO-213): when pg-boss function hardening throws, the queue must never
// create its consumer, and it must refuse new runs. Runs without a database: pg-boss and the hardening
// step are replaced by test doubles.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.js";
import type { ErrorTracker } from "../sentry.js";
import { createJobQueue, QueueUnavailableError, type JobQueueOptions } from "./job-queue.js";
import { hardenPgbossFunctionsSettled } from "./pgboss-hardening.js";
import { runQueueNames } from "./run-job.js";

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(() => Promise.resolve()),
  updateQueue: vi.fn(() => Promise.resolve()),
  work: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    createQueue = boss.createQueue;
    updateQueue = boss.updateQueue;
    work = boss.work;
    stop = boss.stop;
    start(): Promise<void> {
      return Promise.resolve();
    }
    getBamStatus(): Promise<[]> {
      return Promise.resolve([]);
    }
    on(): this {
      return this;
    }
  },
}));

// job-queue.ts uses only these two exports of the hardening module.
vi.mock("./pgboss-hardening.js", () => ({
  hardenPgbossFunctionsSettled: vi.fn(() => Promise.resolve()),
  isBamSettled: () => true,
}));

const tracker: ErrorTracker = {
  isEnabled: false,
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
  close: () => Promise.resolve(true),
};

const executor = { execute: () => Promise.reject(new Error("not reached in these tests")) };

function createQueue(overrides: Partial<JobQueueOptions> = {}) {
  return createJobQueue({
    connectionString: "postgres://unused@127.0.0.1:1/none",
    logger: createLogger({ level: "silent" }),
    errorTracker: tracker,
    startRetryMs: 60_000,
    executor,
    ...overrides,
  });
}

describe("job queue and pgboss function hardening (AGO-213)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed: no consumer, no queue setup, and enqueues are refused when hardening throws", async () => {
    vi.mocked(hardenPgbossFunctionsSettled).mockRejectedValueOnce(
      new Error(
        "pgboss function hardening did not settle within 60000 ms; refusing to run unhardened",
      ),
    );
    const queue = createQueue();

    await queue.start();

    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    await expect(
      queue.enqueueRun({ workspaceId: randomUUID(), runId: randomUUID() }),
    ).rejects.toBeInstanceOf(QueueUnavailableError);
    expect((await queue.health()).status).toBe("down");
    await queue.stop();
    expect(boss.stop).toHaveBeenCalled();
  });

  it("still rejects and retries a failed start when pg-boss stop() never resolves (bounded cleanup)", async () => {
    vi.mocked(hardenPgbossFunctionsSettled).mockRejectedValueOnce(
      new Error("hardening did not settle"),
    );
    boss.stop.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const queue = createQueue({ startRetryMs: 10, failedStartStopTimeoutMs: 50 });

    await queue.start();
    const deadline = Date.now() + 2_000;
    while (boss.work.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(hardenPgbossFunctionsSettled).toHaveBeenCalledTimes(2);
    expect(boss.work).toHaveBeenCalledTimes(1);
    await queue.stop();
  });

  it("AGO-213: the hardening pool ends orphaned sessions with an idle-in-transaction timeout", async () => {
    const poolSpy = vi.spyOn(pg, "Pool");
    try {
      const queue = createQueue();
      const hardeningCall = poolSpy.mock.calls.find(([config]) => config?.keepAlive === true);

      expect(hardeningCall?.[0]).toMatchObject({
        connectionString: "postgres://unused@127.0.0.1:1/none",
        options: "-c idle_in_transaction_session_timeout=15s",
      });
      await queue.stop();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("AGO-213: the hardening pool has its own two connections with keepAlive and a 10 s query timeout", async () => {
    const poolSpy = vi.spyOn(pg, "Pool");
    try {
      const queue = createQueue();
      const hardeningCall = poolSpy.mock.calls.find(([config]) => config?.keepAlive === true);

      expect(hardeningCall?.[0]).toMatchObject({ max: 2, keepAlive: true, query_timeout: 10_000 });
      await queue.stop();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it("starts the consumer once hardening succeeds (control for the fail-closed case)", async () => {
    const queue = createQueue();

    await queue.start();

    expect(boss.work).toHaveBeenCalledTimes(1);
    expect(boss.work).toHaveBeenCalledWith(
      runQueueNames().queue,
      expect.anything(),
      expect.any(Function),
    );
    await queue.stop();
  });
});
