import pg from "pg";
import { PgBoss } from "pg-boss";

import { createApprovalExpirySweeper, createPgApprovalStore } from "../approvals/index.js";
import { createPgRunEventStore, createRunEventEmitter } from "../events/index.js";
import { withContext, type Logger } from "../logger.js";
import { hardenPgbossFunctions } from "./pgboss-hardening.js";
import { createControlSweeper } from "./run-control-sweep.js";
import {
  DEFAULT_RUN_RETRY_POLICY,
  idempotencyKeySchema,
  runJobKey,
  runJobSchema,
  runQueueNames,
  type RunRetryPolicy,
} from "./run-job.js";
import { createRunControl } from "./run-control.js";
import { createRunProcessor, type RunExecutor } from "./run-processor.js";
import { createPgRunStore } from "./run-store.js";
import { createPgCheckpointStore } from "../agent/checkpoint-store.js";

import type { QueueDepth, QueueReport } from "../health.js";
import type { ErrorTracker } from "../sentry.js";

export interface EnqueueRunInput {
  readonly workspaceId: string;
  readonly runId: string;
  /** Optional caller key; the same key never executes twice. Defaults to the run id. */
  readonly idempotencyKey?: string;
  /** A resumed run (AGO-30) was created before: no second `run.created` event. */
  readonly isResume?: boolean;
}

export interface EnqueueRunResult {
  /** False when an equal job already exists (a duplicate): nothing new was queued. */
  readonly enqueued: boolean;
  readonly jobId: string | null;
}

export class QueueUnavailableError extends Error {
  constructor() {
    super("the job queue is not available");
    this.name = "QueueUnavailableError";
  }
}

/** The run is missing, belongs to another workspace, or is not `queued` any more. */
export class RunNotQueueableError extends Error {
  constructor() {
    super("run not found or not queued in this workspace");
    this.name = "RunNotQueueableError";
  }
}

export interface JobQueue {
  /** Connect, install/upgrade pg-boss, start the consumer. Never throws: failures retry in the background. */
  start(): Promise<void>;
  enqueueRun(input: EnqueueRunInput): Promise<EnqueueRunResult>;
  /** AC3: ok + depth while healthy; down otherwise. */
  health(): Promise<QueueReport>;
  /** Stop taking jobs, let running ones finish (up to the drain timeout), then close every connection. */
  stop(): Promise<void>;
}

export interface JobQueueOptions {
  readonly connectionString: string;
  readonly logger: Logger;
  readonly errorTracker: ErrorTracker;
  /** The agent runtime. Without one the queue accepts jobs but nothing consumes them (until AGO-167). */
  readonly executor?: RunExecutor;
  readonly concurrency?: number;
  readonly shutdownTimeoutMs?: number;
  readonly retryPolicy?: RunRetryPolicy;
  /** Seconds between polls for new jobs (min 0.5). */
  readonly pollingIntervalSeconds?: number;
  /** Delay before retrying a failed start (database not up yet). */
  readonly startRetryMs?: number;
  readonly connectionTimeoutMs?: number;
  /**
   * Base name of the pg-boss queue (dead letter: `<name>-dead`). Defaults to `agent-run`. Only tests
   * set it, to give each suite its own queue on the shared database (AGO-202).
   */
  readonly queueName?: string;
  /** Seconds-scale timer for the approval expiry sweep (AGO-21). Only tests set it. */
  readonly approvalSweepIntervalMs?: number;
}

/** pg-boss default schema; created (and locked down) by the AGO-151 migration. */
const PGBOSS_SCHEMA = "pgboss";

type QueueState = "starting" | "ready" | "stopped";

const DEFAULTS = {
  concurrency: 2,
  shutdownTimeoutMs: 25_000,
  pollingIntervalSeconds: 2,
  startRetryMs: 5_000,
  connectionTimeoutMs: 5_000,
} as const;

interface DepthRow {
  name: string;
  state: string;
  count: number;
}

/**
 * Live counts straight from pg-boss's job table. `getQueueStats` serves a cache that is refreshed
 * by a background pass (up to an hour old), which is too stale for a health probe.
 */
const depthSql = (schema: string): string => `
  select name, state, count(*)::int as count
    from ${schema}.job
   where name = any($1::text[]) and state in ('created', 'retry', 'active', 'failed')
   group by name, state`;

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const { logger, errorTracker } = options;
  const { queue: runQueue, deadLetter: deadLetterQueue } = runQueueNames(options.queueName);
  const policy = options.retryPolicy ?? DEFAULT_RUN_RETRY_POLICY;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs;
  const startRetryMs = options.startRetryMs ?? DEFAULTS.startRetryMs;
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs;

  // Our own statements (claim, run events) use this pool; pg-boss keeps its own.
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis,
    idleTimeoutMillis: 10_000,
  });
  pool.on("error", () => undefined);
  const runs = createPgRunStore(pool);
  const events = createPgRunEventStore(pool);
  const checkpoints = createPgCheckpointStore(pool);
  const approvals = createPgApprovalStore(pool);
  // Wakes a run whose approval expired (AGO-21). It goes through the queue like a human's resume does.
  const control = createRunControl({
    runs,
    checkpoints,
    queue: { enqueueRun: (input) => self.enqueueRun(input) },
    events,
    logger,
  });
  // Expires pending approvals past `expires_at` into `rejected` and tells the run (timeout means deny).
  const approvalSweeper = createApprovalExpirySweeper({
    approvals,
    events,
    control,
    logger,
    intervalMs: options.approvalSweepIntervalMs,
    onError: (error, context) => {
      errorTracker.captureException(error, context);
    },
  });

  // AGO-86: applies a person's stop or resume request to runs that have no loop running (queued or paused).
  const controlSweeper = createControlSweeper({
    runs,
    approvals,
    checkpoints,
    events,
    control,
    logger,
    onError: (error, context) => {
      errorTracker.captureException(error, context);
    },
  });

  let state: QueueState = "starting";
  const isStopped = (): boolean => state === "stopped";
  let boss: PgBoss | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let starting: Promise<void> | null = null;

  const newBoss = (): PgBoss => {
    const instance = new PgBoss({
      connectionString: options.connectionString,
      application_name: "ago-worker",
      connectionTimeoutMillis,
      max: 4,
      schedule: false,
    });
    // An unhandled 'error' event would crash the process; report it and keep running.
    instance.on("error", (error) => {
      logger.error({ err: error }, "job queue error");
      errorTracker.captureException(error);
    });
    return instance;
  };

  async function connect(): Promise<void> {
    const instance = newBoss();
    try {
      await instance.start();
      // pg-boss may have (re)created functions during install or upgrade: close their default PUBLIC grant.
      await hardenPgbossFunctions(pool);
      await instance.createQueue(deadLetterQueue, { policy: "standard" });
      const queueSettings = {
        deadLetter: deadLetterQueue,
        retryLimit: policy.retryLimit,
        retryDelay: policy.retryDelaySeconds,
        retryBackoff: true,
        retryDelayMax: policy.retryDelayMaxSeconds,
        expireInSeconds: policy.expireInSeconds,
      };
      // Exclusive: one queued-or-active job per singletonKey, so a duplicate enqueue is dropped.
      await instance.createQueue(runQueue, { policy: "exclusive", ...queueSettings });
      // createQueue keeps an existing queue as it is; the processor relies on this retry limit, so
      // converge the stored settings to the code on every start.
      await instance.updateQueue(runQueue, queueSettings);
      if (options.executor === undefined) {
        logger.warn("no run executor configured: runs are queued but nothing consumes them yet");
      } else {
        const processRunJob = createRunProcessor({
          runs,
          events,
          executor: options.executor,
          logger,
          errorTracker,
          checkpoints,
          approvals,
          retryLimit: policy.retryLimit,
          staleAfterSeconds: policy.expireInSeconds,
        });
        await instance.work(
          runQueue,
          {
            batchSize: 1,
            localConcurrency: options.concurrency ?? DEFAULTS.concurrency,
            pollingIntervalSeconds:
              options.pollingIntervalSeconds ?? DEFAULTS.pollingIntervalSeconds,
          },
          async (jobs) => {
            for (const job of jobs) await processRunJob(job);
          },
        );
      }
    } catch (error) {
      await instance.stop({ close: true, graceful: false }).catch(() => undefined);
      throw error;
    }
    if (isStopped()) {
      await instance.stop({ close: true, graceful: false }).catch(() => undefined);
      return;
    }
    boss = instance;
    state = "ready";
    // Only a worker that runs agents can have runs waiting on an approval.
    if (options.executor !== undefined) {
      approvalSweeper.start();
      controlSweeper.start();
    }
    logger.info({ queue: runQueue, consumer: options.executor !== undefined }, "job queue started");
  }

  async function startWithRetry(): Promise<void> {
    if (isStopped()) return;
    try {
      await connect();
    } catch (error) {
      logger.error({ err: error }, "job queue failed to start; retrying");
      if (isStopped()) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        starting = startWithRetry();
      }, startRetryMs);
      retryTimer.unref();
    }
  }

  async function readDepth(instance: PgBoss): Promise<QueueDepth> {
    const { rows } = await instance
      .getDb()
      .executeSql(depthSql(PGBOSS_SCHEMA), [[runQueue, deadLetterQueue]]);
    const counts = new Map<string, number>();
    for (const row of rows as DepthRow[]) {
      const key = `${row.name}:${row.state}`;
      counts.set(key, (counts.get(key) ?? 0) + row.count);
    }
    const at = (queue: string, ...states: string[]): number =>
      states.reduce((total, state) => total + (counts.get(`${queue}:${state}`) ?? 0), 0);
    return {
      queued: at(runQueue, "created", "retry"),
      active: at(runQueue, "active"),
      failed: at(runQueue, "failed"),
      dead_letter: at(deadLetterQueue, "created", "retry", "active"),
    };
  }

  const self: JobQueue = {
    start() {
      starting = startWithRetry();
      return starting;
    },

    async enqueueRun(input) {
      const instance = boss;
      if (state !== "ready" || instance === null) throw new QueueUnavailableError();
      const payload = runJobSchema.parse({
        workspace_id: input.workspaceId,
        run_id: input.runId,
      });
      const key =
        input.idempotencyKey === undefined
          ? undefined
          : idempotencyKeySchema.parse(input.idempotencyKey);

      const run = await runs.findQueuedRun({
        workspaceId: payload.workspace_id,
        runId: payload.run_id,
      });
      if (run === null) throw new RunNotQueueableError();

      const jobId = await instance.send(runQueue, payload, {
        singletonKey: runJobKey(payload, key),
      });
      const jobLogger = withContext(logger, {
        run_id: payload.run_id,
        workspace_id: payload.workspace_id,
        agent_id: run.agentId,
      });
      if (jobId === null) {
        jobLogger.info("duplicate enqueue ignored");
        return { enqueued: false, jobId: null };
      }
      if (input.isResume === true) {
        jobLogger.info({ job_id: jobId }, "resumed run enqueued");
        return { enqueued: true, jobId };
      }
      try {
        await createRunEventEmitter({
          workspaceId: payload.workspace_id,
          runId: payload.run_id,
          store: events,
          logger: jobLogger,
        }).emit({ type: "run.created", payload: { agent_id: run.agentId, task_id: run.taskId } });
      } catch (error) {
        // The job is queued and will run; a missing audit row must not be silent.
        jobLogger.error({ err: error }, "run.created event not recorded");
        errorTracker.captureException(error, {
          run_id: payload.run_id,
          workspace_id: payload.workspace_id,
        });
      }
      jobLogger.info({ job_id: jobId }, "run enqueued");
      return { enqueued: true, jobId };
    },

    async health() {
      const instance = boss;
      if (state !== "ready" || instance === null) return { status: "down" };
      try {
        return { status: "ok", depth: await readDepth(instance) };
      } catch {
        return { status: "down" };
      }
    },

    async stop() {
      state = "stopped";
      approvalSweeper.stop();
      controlSweeper.stop();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      await starting?.catch(() => undefined);
      const instance = boss;
      boss = null;
      if (instance !== null) {
        // Graceful: no new jobs are fetched; running handlers get `timeout` to finish.
        await instance
          .stop({ graceful: true, close: true, timeout: shutdownTimeoutMs })
          .catch((error: unknown) => {
            logger.error({ err: error }, "job queue did not stop cleanly");
          });
      }
      await pool.end().catch(() => undefined);
    },
  };
  return self;
}
