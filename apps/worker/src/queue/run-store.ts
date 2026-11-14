import type pg from "pg";

/** `public.runs.status` values this ticket uses. The column is free text (AGO-74). */
export const RUN_STATUS = {
  queued: "queued",
  running: "running",
  paused: "paused",
  succeeded: "succeeded",
  failed: "failed",
  /** AGO-86: a person stopped the run. Final: no transition leaves it. */
  stopped: "stopped",
} as const;

/** The states a stop can move a run out of. */
export type StoppableStatus = "queued" | "running" | "paused";

export interface RunRef {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface QueuedRun {
  readonly agentId: string;
  readonly taskId: string | null;
}

export interface ClaimOptions {
  /**
   * A retried job may take back a run left `running` by a worker that died: pg-boss only retries a
   * job after the previous attempt expired, so a `running` run older than `staleAfterSeconds` has
   * no live owner. A first attempt never does this.
   */
  readonly allowStaleReclaim: boolean;
  readonly staleAfterSeconds: number;
}

/**
 * Persistence port for the queue. Every statement is scoped by `workspace_id`. The claim is the
 * database-side guard behind AC1: a conditional update, so however many jobs name one run, only one
 * of them can move it out of `queued`.
 */
export interface RunStore {
  /** The run if it exists in this workspace and is still `queued`; otherwise null. */
  findQueuedRun(ref: RunRef): Promise<QueuedRun | null>;
  /** Atomically move `queued` -> `running`. Null means another job already owns (or finished) the run. */
  claimRun(ref: RunRef, options: ClaimOptions): Promise<QueuedRun | null>;
  /** Give the run back (`running` -> `queued`) so a retry can claim it. */
  releaseRun(ref: RunRef): Promise<void>;
  markFinished(ref: RunRef, status: "succeeded" | "failed"): Promise<void>;
  /** `running` -> `paused`: the run waits for a human decision (AGO-167). Not finished, no `finished_at`. */
  markPaused(ref: RunRef): Promise<void>;
  /** `paused` -> `queued` (AGO-30). True only for the one caller that moved it; a second resume gets false. */
  resumeRun(ref: RunRef): Promise<boolean>;
  /**
   * `paused` -> `queued` for the approval-expiry wake (AGO-21, race fixed in AGO-58): ONE conditional update that
   * moves the run only while it is still `paused` AND no human pause request is recorded. The pause flag is read
   * inside the same statement, so the window for a human pause to be missed is narrowed to a single statement
   * (it was several awaited calls). Under READ COMMITTED it is not zero. True only for the one caller that moved it.
   */
  wakeRunAfterExpiry(ref: RunRef): Promise<boolean>;
  /** `queued` -> `paused`: undo `resumeRun` when the job could not be enqueued. */
  revertResume(ref: RunRef): Promise<void>;
  /**
   * AGO-86: move the run from one of `from` to `stopped` (sets `finished_at`). ONE conditional update, so of two
   * callers only one moves it; True only for that caller. `stopped` is final: every other transition above is
   * conditional on a different status, so none can leave it. A running run is stopped by its own loop, never by
   * the sweep, so no tool call is cut short.
   */
  markStopped(ref: RunRef, from: readonly StoppableStatus[]): Promise<boolean>;
}

interface RunRow {
  agent_id: string;
  task_id: string | null;
}

const toQueuedRun = (row: RunRow): QueuedRun => ({ agentId: row.agent_id, taskId: row.task_id });

export function createPgRunStore(pool: pg.Pool): RunStore {
  return {
    async findQueuedRun({ workspaceId, runId }) {
      const result = await pool.query<RunRow>(
        `select agent_id, task_id from public.runs
          where workspace_id = $1 and id = $2 and status = $3`,
        [workspaceId, runId, RUN_STATUS.queued],
      );
      const row = result.rows[0];
      return row === undefined ? null : toQueuedRun(row);
    },

    async claimRun({ workspaceId, runId }, options) {
      const result = await pool.query<RunRow>(
        `update public.runs
            set status = $3, started_at = coalesce(started_at, now())
          where workspace_id = $1 and id = $2
            and (status = $4
                 or ($5::boolean and status = $3
                     and updated_at < now() - make_interval(secs => $6::double precision)))
        returning agent_id, task_id`,
        [
          workspaceId,
          runId,
          RUN_STATUS.running,
          RUN_STATUS.queued,
          options.allowStaleReclaim,
          options.staleAfterSeconds,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : toQueuedRun(row);
    },

    async releaseRun({ workspaceId, runId }) {
      await pool.query(
        `update public.runs set status = $3
          where workspace_id = $1 and id = $2 and status = $4`,
        [workspaceId, runId, RUN_STATUS.queued, RUN_STATUS.running],
      );
    },

    async markPaused({ workspaceId, runId }) {
      await pool.query(
        `update public.runs set status = $3
          where workspace_id = $1 and id = $2 and status = $4`,
        [workspaceId, runId, RUN_STATUS.paused, RUN_STATUS.running],
      );
    },

    async resumeRun({ workspaceId, runId }) {
      // AGO-86: a run a person asked to stop is never resumed, even though its stop has not been finalized yet.
      const result = await pool.query(
        `update public.runs r set status = $3
          where r.workspace_id = $1 and r.id = $2 and r.status = $4
            and not exists (
              select 1 from private.run_checkpoints c
               where c.workspace_id = r.workspace_id and c.run_id = r.id
                 and c.stop_requested_at is not null)`,
        [workspaceId, runId, RUN_STATUS.queued, RUN_STATUS.paused],
      );
      return result.rowCount === 1;
    },

    async markStopped({ workspaceId, runId }, from) {
      const result = await pool.query(
        `update public.runs set status = $3, finished_at = now()
          where workspace_id = $1 and id = $2 and status = any($4::text[])`,
        [workspaceId, runId, RUN_STATUS.stopped, [...from]],
      );
      return result.rowCount === 1;
    },

    async wakeRunAfterExpiry({ workspaceId, runId }) {
      // The pause flag lives in private.run_checkpoints. A run with no checkpoint row has no pause request, but
      // it also has no awaiting call, so the caller has already answered not_waiting for it.
      const result = await pool.query(
        `update public.runs r set status = $3
          where r.workspace_id = $1 and r.id = $2 and r.status = $4
            and not exists (
              select 1 from private.run_checkpoints c
               where c.workspace_id = r.workspace_id and c.run_id = r.id
                 and (c.pause_requested_at is not null or c.stop_requested_at is not null))`,
        [workspaceId, runId, RUN_STATUS.queued, RUN_STATUS.paused],
      );
      return result.rowCount === 1;
    },

    async revertResume({ workspaceId, runId }) {
      await pool.query(
        `update public.runs set status = $3
          where workspace_id = $1 and id = $2 and status = $4`,
        [workspaceId, runId, RUN_STATUS.paused, RUN_STATUS.queued],
      );
    },

    async markFinished({ workspaceId, runId }, status) {
      await pool.query(
        `update public.runs set status = $3, finished_at = now()
          where workspace_id = $1 and id = $2 and status = $4`,
        [workspaceId, runId, status, RUN_STATUS.running],
      );
    },
  };
}
