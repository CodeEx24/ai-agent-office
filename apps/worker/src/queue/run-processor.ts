import {
  createRunEventEmitter,
  type RunEventEmitter,
  type RunEventStore,
} from "../events/index.js";
import { scrubString, withContext, type Logger } from "../logger.js";
import { runJobSchema, type RunJobPayload } from "./run-job.js";
import { RUN_STATUS, type RunStore } from "./run-store.js";

import type { CheckpointStore } from "../agent/checkpoint-store.js";
import type { ErrorTracker } from "../sentry.js";

/** What the agent runtime (AGO-167) is given for one run. */
export interface RunExecutionContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  /** 0 for the first attempt, then 1, 2... for each retry. */
  readonly attempt: number;
  readonly logger: Logger;
  readonly emitter: RunEventEmitter;
  /** Aborted when the worker is shutting down past its drain timeout. */
  readonly signal: AbortSignal;
}

/**
 * How the loop ended. `completed` (the default) is a result. `limit_reached`: the loop already emitted
 * `run.limit_reached`, so the run is marked failed and no `run.completed` is written. `paused`: a tool
 * call needs a human (the loop already emitted `approval.requested`) or a human asked for a pause; the run waits
 * for a resume (AGO-30, `resumeRun`).
 * `loop_detected` (AGO-166): the loop already emitted `run.loop_detected` after the same tool call repeated with
 * the same result, so the run is marked failed with no `run.completed`, like a limit.
 */
export type RunEnd = "completed" | "limit_reached" | "paused" | "loop_detected";

/** Why a run paused: a policy needs an approval, or a human asked for the pause (AGO-30). */
export type PauseReason = "approval_required" | "user_pause";

export interface RunOutcome {
  readonly steps: number;
  /** Only read when `end` is `paused`; missing means `approval_required` (the AGO-167 behaviour). */
  readonly pauseReason?: PauseReason;
  readonly summary?: string;
  readonly end?: RunEnd;
}

/** A failure a retry cannot fix (archived agent, missing run). The run fails at once, with `reason`. */
export class NonRetryableRunError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "NonRetryableRunError";
    this.reason = reason;
  }
}

/** The seam to the agent tool loop. Throwing means the attempt failed and may be retried. */
export interface RunExecutor {
  execute(context: RunExecutionContext): Promise<RunOutcome>;
}

/** The slice of a pg-boss job the processor needs. */
export interface RunJob {
  readonly id: string;
  readonly data: unknown;
  readonly retryCount: number;
  readonly signal: AbortSignal;
}

export type RunJobResult = "executed" | "skipped_duplicate" | "failed_permanently";

export interface RunProcessorDeps {
  readonly runs: RunStore;
  readonly events: RunEventStore;
  readonly executor: RunExecutor;
  readonly logger: Logger;
  readonly errorTracker: ErrorTracker;
  /** Where the loop saved the run's state (AGO-30). Dropped when the run ends for good; omitted: nothing to drop. */
  readonly checkpoints?: Pick<CheckpointStore, "clear">;
  /** Retries allowed after the first attempt: the attempt with `retryCount` of this is the last. */
  readonly retryLimit: number;
  /** Matches the job's expiry; a `running` run older than this has lost its worker. */
  readonly staleAfterSeconds: number;
}

const FAILURE_MESSAGE_MAX = 300;

/** A failure message that is safe to store in an append-only log: scrubbed and bounded. */
function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown error";
  return scrubString(raw).slice(0, FAILURE_MESSAGE_MAX);
}

export function createRunProcessor(deps: RunProcessorDeps) {
  const { runs, events, executor, logger, errorTracker } = deps;

  return async function processRunJob(job: RunJob): Promise<RunJobResult> {
    const parsed = runJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // Paths only: the payload itself is never echoed.
      const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
      logger.error({ job_id: job.id, fields }, "run job has an invalid payload");
      throw new Error("invalid run job payload");
    }
    const payload: RunJobPayload = parsed.data;
    const ref = { workspaceId: payload.workspace_id, runId: payload.run_id };
    const attempt = job.retryCount;

    const run = await runs.claimRun(ref, {
      allowStaleReclaim: attempt > 0,
      staleAfterSeconds: deps.staleAfterSeconds,
    });
    const jobLogger = withContext(logger, {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      ...(run === null ? {} : { agent_id: run.agentId }),
    });
    if (run === null) {
      // AC1: a second job for the same run finds it already claimed or finished and does nothing.
      jobLogger.info({ job_id: job.id }, "run already claimed or finished; skipping duplicate job");
      return "skipped_duplicate";
    }

    const emitter = createRunEventEmitter({
      workspaceId: payload.workspace_id,
      runId: payload.run_id,
      store: events,
      logger: jobLogger,
    });

    // The run is over: its saved state is not needed any more (the event log keeps the history).
    const dropCheckpoint = async (): Promise<void> => {
      await deps.checkpoints?.clear(ref).catch((clearError: unknown) => {
        jobLogger.error({ err: clearError }, "could not drop the run checkpoint");
      });
    };

    const handleFailure = async (error: unknown): Promise<void> => {
      const isFinalAttempt = error instanceof NonRetryableRunError || attempt >= deps.retryLimit;
      if (!isFinalAttempt) {
        // Give the run back so the backoff retry can claim it again.
        jobLogger.warn({ job_id: job.id, attempt, err: error }, "run attempt failed; will retry");
        await runs.releaseRun(ref).catch((releaseError: unknown) => {
          jobLogger.error({ err: releaseError }, "could not release run for retry");
        });
        return;
      }
      jobLogger.error({ job_id: job.id, attempt, err: error }, "run failed after all retries");
      errorTracker.captureException(error, {
        run_id: payload.run_id,
        agent_id: run.agentId,
        workspace_id: payload.workspace_id,
      });
      await runs.markFinished(ref, RUN_STATUS.failed).catch((markError: unknown) => {
        jobLogger.error({ err: markError }, "could not mark run failed");
      });
      await dropCheckpoint();
      await emitter
        .emit({
          type: "run.failed",
          payload: {
            reason: error instanceof NonRetryableRunError ? error.reason : "retries_exhausted",
            message: describeFailure(error),
          },
        })
        .catch(() => undefined); // already logged by the emitter; the job failure must still surface
    };

    try {
      await emitter.emit({ type: "run.started", payload: {} });
      const outcome = await executor.execute({
        workspaceId: payload.workspace_id,
        runId: payload.run_id,
        agentId: run.agentId,
        taskId: run.taskId,
        attempt,
        logger: jobLogger,
        emitter,
        signal: job.signal,
      });
      const end = outcome.end ?? "completed";
      if (end === "limit_reached") {
        // The loop wrote run.limit_reached, the terminal event. A run that hit a limit has no result.
        await runs.markFinished(ref, RUN_STATUS.failed);
        await dropCheckpoint();
        jobLogger.warn({ job_id: job.id, attempt, steps: outcome.steps }, "run stopped at a limit");
        return "executed";
      }
      if (end === "loop_detected") {
        // The loop wrote run.loop_detected, the terminal event. A run stuck in a loop has no result.
        await runs.markFinished(ref, RUN_STATUS.failed);
        await dropCheckpoint();
        jobLogger.warn(
          { job_id: job.id, attempt, steps: outcome.steps },
          "run stopped: loop detected",
        );
        return "executed";
      }
      if (end === "paused") {
        const reason = outcome.pauseReason ?? "approval_required";
        await emitter.emit({
          type: "run.paused",
          payload: { requested_by: reason === "user_pause" ? "human" : "policy", reason },
        });
        await runs.markPaused(ref);
        jobLogger.info({ job_id: job.id, attempt, reason }, "run paused");
        return "executed";
      }
      await emitter.emit({
        type: "run.completed",
        payload: {
          steps: outcome.steps,
          ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
        },
      });
      await runs.markFinished(ref, RUN_STATUS.succeeded);
      await dropCheckpoint();
      jobLogger.info({ job_id: job.id, attempt }, "run completed");
      return "executed";
    } catch (error) {
      await handleFailure(error);
      // A retry cannot fix this one: the run is already failed, so do not spend the backoff retries.
      if (error instanceof NonRetryableRunError) return "failed_permanently";
      throw error;
    }
  };
}
