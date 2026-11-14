import { APPROVAL_STATUS } from "@ago/shared";

import type pg from "pg";

/**
 * Persistence port for approval requests (AGO-21). Every statement is scoped by `workspace_id`, except the
 * expiry sweep, which is a system job over all workspaces and returns the workspace of each row it moved.
 *
 * The runtime only ever writes `pending` (create) and `rejected` (expiry). It never writes `approved` or
 * `denied`: only a human can, through RLS (AGO-107). No payload is stored, only its SHA-256.
 */
export interface NewApproval {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly approvalId: string;
  /** The tool name. Never the tool input. */
  readonly action: string;
  /** SHA-256 hex of the exact call the approval covers. */
  readonly payloadHash: string;
  readonly expiresAt: Date;
}

export interface StoredApproval {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly status: string;
  readonly payloadHash: string;
  readonly expiresAt: Date;
}

/** An approval the runtime just moved from `pending` to `rejected`. Returned once, to the one caller that moved it. */
export interface ExpiredApproval {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly payloadHash: string;
}

export interface ApprovalStore {
  /**
   * Insert a `pending` approval, or return the row that already has this id (a retry). Rejects when the
   * existing row is for another run or another payload hash: nothing may be bound to the wrong call.
   */
  create(input: NewApproval): Promise<StoredApproval>;
  get(ref: { workspaceId: string; approvalId: string }): Promise<StoredApproval | null>;
  /**
   * `pending` -> `rejected` for one approval that is past `expires_at`. Null when it is not pending any more
   * or not yet due. A conditional update, so of two callers racing only one gets the row.
   */
  expire(
    ref: { workspaceId: string; approvalId: string },
    now: Date,
  ): Promise<ExpiredApproval | null>;
  /** The same move for every pending approval past `expires_at`, oldest first, at most `limit`. */
  expireDue(now: Date, limit: number): Promise<readonly ExpiredApproval[]>;
}

/** The row for this approval id belongs to a different run or payload. Fail closed. */
export class ApprovalConflictError extends Error {
  constructor() {
    super("an approval with this id already exists for a different run or payload");
    this.name = "ApprovalConflictError";
  }
}

interface ApprovalRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  status: string;
  payload_hash: string;
  expires_at: Date;
}

interface ExpiredRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  payload_hash: string;
}

const toStored = (row: ApprovalRow): StoredApproval => ({
  approvalId: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  status: row.status,
  payloadHash: row.payload_hash,
  expiresAt: row.expires_at,
});

const toExpired = (row: ExpiredRow): ExpiredApproval => ({
  approvalId: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  payloadHash: row.payload_hash,
});

const SELECT_ONE = `select id, workspace_id, run_id, status, payload_hash, expires_at
                      from public.approvals where workspace_id = $1 and id = $2`;

export function createPgApprovalStore(pool: pg.Pool): ApprovalStore {
  async function get(ref: {
    workspaceId: string;
    approvalId: string;
  }): Promise<StoredApproval | null> {
    const result = await pool.query<ApprovalRow>(SELECT_ONE, [ref.workspaceId, ref.approvalId]);
    const row = result.rows[0];
    return row === undefined ? null : toStored(row);
  }

  return {
    get,

    async create(input) {
      await pool.query(
        `insert into public.approvals
           (id, workspace_id, run_id, agent_id, action, payload_hash, status, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict do nothing`,
        [
          input.approvalId,
          input.workspaceId,
          input.runId,
          input.agentId,
          input.action,
          input.payloadHash,
          APPROVAL_STATUS.pending,
          input.expiresAt,
        ],
      );
      const stored = await get({ workspaceId: input.workspaceId, approvalId: input.approvalId });
      // Null: the id exists in another workspace. A different run or hash: not the call this retry is for.
      if (stored?.runId !== input.runId || stored.payloadHash !== input.payloadHash) {
        throw new ApprovalConflictError();
      }
      return stored;
    },

    async expire(ref, now) {
      const result = await pool.query<ExpiredRow>(
        `update public.approvals set status = $3
          where workspace_id = $1 and id = $2
            and status = $4 and consumed_at is null and expires_at <= $5
          returning id, workspace_id, run_id, payload_hash`,
        [ref.workspaceId, ref.approvalId, APPROVAL_STATUS.rejected, APPROVAL_STATUS.pending, now],
      );
      const row = result.rows[0];
      return row === undefined ? null : toExpired(row);
    },

    async expireDue(now, limit) {
      const result = await pool.query<ExpiredRow>(
        // The ids come from one array(select ...), evaluated once. A plain "id in (select ... limit)" can be
        // re-planned per row and then moves more rows than the limit. The outer guard keeps "pending only".
        `update public.approvals set status = $1
          where id = any(array(
            select id from public.approvals
             where status = $2 and consumed_at is null and expires_at <= $3
             order by expires_at
             limit $4
             for update skip locked))
            and status = $2 and consumed_at is null
          returning id, workspace_id, run_id, payload_hash`,
        [APPROVAL_STATUS.rejected, APPROVAL_STATUS.pending, now, limit],
      );
      return result.rows.map(toExpired);
    },
  };
}
