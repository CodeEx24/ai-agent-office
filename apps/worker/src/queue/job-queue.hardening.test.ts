// Queue-level fail-closed check (AGO-213): when pg-boss function hardening throws, the queue must never
// create its consumer, and it must refuse new runs. Runs without a database: pg-boss and the hardening
// step are replaced by test doubles.
import { randomUUID } from "node:crypto";

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
