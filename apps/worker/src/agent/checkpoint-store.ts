import {
  parseRunCheckpointState,
  RUN_CHECKPOINT_MAX_BYTES,
  type RunCheckpointState,
} from "@ago/shared";

import type pg from "pg";

/**
 * Persistence port for a run's checkpoint and pause request (AGO-30). Every statement is scoped by
 * `workspace_id`. The table is `private.run_checkpoints`: only the worker's database role can touch it.
 */
export interface CheckpointRef {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface LoadedCheckpoint {
  /** Null when the run has no state yet (first attempt, or only a pause request was stored). */
  readonly state: RunCheckpointState | null;
}

/** A stored state that does not parse. Carries a reason code only, never the stored content. */
export class CheckpointUnreadableError extends Error {
  readonly reason: "invalid" | "unsupported_version";
  constructor(reason: "invalid" | "unsupported_version") {
    super(`the stored run checkpoint is not readable (${reason})`);
    this.name = "CheckpointUnreadableError";
    this.reason = reason;
  }
}

/** The state is too large to store. The loop keeps results capped, so this means a bug, not a big run. */
export class CheckpointTooLargeError extends Error {
  constructor() {
    super("the run checkpoint is larger than the storage cap");
    this.name = "CheckpointTooLargeError";
  }
}

export interface RunControlFlags {
  readonly pauseRequested: boolean;
  readonly stopRequested: boolean;
}

/** One open request from `public.request_run_control`. `requestedBy` is the person's user id, when recorded. */
export interface ControlRequest extends CheckpointRef {
  readonly stopRequested: boolean;
  readonly resumeRequested: boolean;
  readonly requestedBy: string | null;
}

export interface CheckpointStore {
  /** Throws `CheckpointUnreadableError` when a stored state does not parse: the loop never guesses. */
  load(ref: CheckpointRef): Promise<LoadedCheckpoint>;
  /** Insert or replace the state. The pause request is left as it is. */
  save(ref: CheckpointRef, state: RunCheckpointState): Promise<void>;
  /** True once a human has asked for a pause and the request has not been cleared by a resume. */
  isPauseRequested(ref: CheckpointRef): Promise<boolean>;
  /** Record a pause request for a `queued` or `running` run. False when the run is not in such a state. */
  requestPause(ref: CheckpointRef): Promise<boolean>;
  /** Forget the pause request and any resume request (a resume does this). */
  clearPause(ref: CheckpointRef): Promise<void>;
  /**
   * The human control flags of a run, in ONE read (AGO-86): the loop calls this before every tool call. A failure
   * throws, so the attempt fails and is retried: a flag that cannot be read never lets a call through.
   */
  readControl(ref: CheckpointRef): Promise<RunControlFlags>;
  /** Forget only the resume request (the sweep has handled it, whatever came of it). */
  clearResumeRequest(ref: CheckpointRef): Promise<void>;
  /** Runs with a stop or resume request a person recorded and the worker has not handled yet (AGO-86). */
  listControlRequests(limit: number): Promise<readonly ControlRequest[]>;
  /** Delete the checkpoint and the pause request (the run is over; the event log keeps the history). */
  clear(ref: CheckpointRef): Promise<void>;
}

/** No persistence: a loop built without a store behaves as before AGO-30 (state lives in memory only). */
export const noopCheckpointStore: CheckpointStore = {
  load: () => Promise.resolve({ state: null }),
  save: () => Promise.resolve(),
  isPauseRequested: () => Promise.resolve(false),
  requestPause: () => Promise.resolve(false),
  clearPause: () => Promise.resolve(),
  readControl: () => Promise.resolve({ pauseRequested: false, stopRequested: false }),
  clearResumeRequest: () => Promise.resolve(),
  listControlRequests: () => Promise.resolve([]),
  clear: () => Promise.resolve(),
};

interface CheckpointRow {
  state: unknown;
}

export function createPgCheckpointStore(pool: pg.Pool): CheckpointStore {
  return {
    async load({ workspaceId, runId }) {
      const result = await pool.query<CheckpointRow>(
        `select state from private.run_checkpoints where workspace_id = $1 and run_id = $2`,
        [workspaceId, runId],
      );
      const row = result.rows[0];
      if (row === undefined || row.state === null) return { state: null };
      const parsed = parseRunCheckpointState(row.state);
      if (!parsed.ok) throw new CheckpointUnreadableError(parsed.reason);
      return { state: parsed.state };
    },

    async save({ workspaceId, runId }, state) {
      const json = JSON.stringify(state);
      if (Buffer.byteLength(json, "utf8") > RUN_CHECKPOINT_MAX_BYTES) {
        throw new CheckpointTooLargeError();
      }
      await pool.query(
        `insert into private.run_checkpoints (workspace_id, run_id, state)
         values ($1, $2, $3::jsonb)
         on conflict (workspace_id, run_id) do update set state = excluded.state`,
        [workspaceId, runId, json],
      );
    },

    async isPauseRequested({ workspaceId, runId }) {
      const result = await pool.query(
        `select 1 from private.run_checkpoints
          where workspace_id = $1 and run_id = $2 and pause_requested_at is not null`,
        [workspaceId, runId],
      );
      return result.rowCount === 1;
    },

    async requestPause({ workspaceId, runId }) {
      // The select scopes by workspace and only offers a run that can still be paused; the foreign key
      // keeps a row from ever naming another workspace's run.
      const result = await pool.query(
        `insert into private.run_checkpoints (workspace_id, run_id, pause_requested_at)
         select workspace_id, id, now() from public.runs
          where workspace_id = $1 and id = $2 and status in ('queued', 'running')
         on conflict (workspace_id, run_id) do update
           set pause_requested_at = coalesce(private.run_checkpoints.pause_requested_at, now())`,
        [workspaceId, runId],
      );
      return result.rowCount === 1;
    },

    async clearPause({ workspaceId, runId }) {
      await pool.query(
        `update private.run_checkpoints set pause_requested_at = null, resume_requested_at = null
          where workspace_id = $1 and run_id = $2`,
        [workspaceId, runId],
      );
    },

    async readControl({ workspaceId, runId }) {
      const result = await pool.query<{ is_pause: boolean; is_stop: boolean }>(
        `select pause_requested_at is not null as is_pause, stop_requested_at is not null as is_stop
           from private.run_checkpoints where workspace_id = $1 and run_id = $2`,
        [workspaceId, runId],
      );
      const row = result.rows[0];
      return { pauseRequested: row?.is_pause === true, stopRequested: row?.is_stop === true };
    },

    async clearResumeRequest({ workspaceId, runId }) {
      await pool.query(
        `update private.run_checkpoints set resume_requested_at = null
          where workspace_id = $1 and run_id = $2`,
        [workspaceId, runId],
      );
    },

    async listControlRequests(limit) {
      const result = await pool.query<{
        workspace_id: string;
        run_id: string;
        is_stop: boolean;
        is_resume: boolean;
        control_requested_by: string | null;
      }>(
        `select workspace_id, run_id, stop_requested_at is not null as is_stop,
                resume_requested_at is not null as is_resume, control_requested_by
           from private.run_checkpoints
          where stop_requested_at is not null or resume_requested_at is not null
          order by coalesce(stop_requested_at, resume_requested_at)
          limit $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        workspaceId: row.workspace_id,
        runId: row.run_id,
        stopRequested: row.is_stop,
        resumeRequested: row.is_resume,
        requestedBy: row.control_requested_by,
      }));
    },

    async clear({ workspaceId, runId }) {
      await pool.query(
        `delete from private.run_checkpoints where workspace_id = $1 and run_id = $2`,
        [workspaceId, runId],
      );
    },
  };
}
