import type pg from "pg";

/** `public.runs.status` values this ticket uses. The column is free text (AGO-74). */
export const RUN_STATUS = {
  queued: "queued",
  running: "running",
  paused: "paused",
  succeeded: "succeeded",
  failed: "failed",
} as const;

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

    async markFinished({ workspaceId, runId }, status) {
      await pool.query(
        `update public.runs set status = $3, finished_at = now()
          where workspace_id = $1 and id = $2 and status = $4`,
        [workspaceId, runId, status, RUN_STATUS.running],
      );
    },
  };
}
