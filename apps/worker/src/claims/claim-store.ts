import {
  claimRefSchema,
  claimReleaseReasonSchema,
  claimTaskInputSchema,
  claimTaskResultSchema,
  CLAIM_TTL_DEFAULT_SECONDS,
  releaseClaimResultSchema,
  renewClaimResultSchema,
  type ClaimRef,
  type ClaimReleaseReason,
  type ClaimTaskInput,
  type ClaimTaskResult,
  type ReleaseClaimResult,
  type RenewClaimResult,
} from "@ago/shared";

/** The part of `pg.Pool` this module uses, so a test can pass a stub. */
export interface ClaimQueryable {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * Port for task claims (AGO-160). The database does the work: every method is one SQL function call, so the
 * decision is atomic and uses the database clock. This module never checks "is it free" in application code.
 * The claim token proves ownership: keep it in memory, never log it, never put it in a run event.
 */
export interface ClaimStore {
  /** Take a task for an agent. `held` and `refused` are normal answers, not errors. */
  claim(input: ClaimTaskInput): Promise<ClaimTaskResult>;
  /** Extend a live claim. Refused once the claim expired, was released, or another agent holds the task. */
  renew(ref: ClaimRef, ttlSeconds?: number): Promise<RenewClaimResult>;
  /** Give the task back (`released`) or finish it (`completed`). Needs the current token. */
  release(ref: ClaimRef, reason?: ClaimReleaseReason): Promise<ReleaseClaimResult>;
  /** Free every expired claim (one workspace, or all). Returns how many were freed. */
  sweepExpired(workspaceId?: string): Promise<number>;
}

interface ClaimTaskRow {
  outcome: string;
  reason: string | null;
  claim_id: string | null;
  claim_token: string | null;
  expires_at: Date | string | null;
  holder_agent_id: string | null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function firstRow(rows: readonly unknown[], what: string): unknown {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

export function createPgClaimStore(db: ClaimQueryable): ClaimStore {
  return {
    async claim(rawInput) {
      const input = claimTaskInputSchema.parse(rawInput);
      const result = await db.query("select * from public.claim_task($1, $2, $3, $4, $5)", [
        input.workspaceId,
        input.taskId,
        input.agentId,
        input.runId,
        input.ttlSeconds,
      ]);
      const row = firstRow(result.rows, "claim_task") as ClaimTaskRow;
      if (row.outcome === "claimed") {
        return claimTaskResultSchema.parse({
          outcome: "claimed",
          claimId: row.claim_id,
          claimToken: row.claim_token,
          expiresAt: toDate(row.expires_at),
        });
      }
      if (row.outcome === "held") {
        return claimTaskResultSchema.parse({
          outcome: "held",
          holderAgentId: row.holder_agent_id,
          expiresAt: toDate(row.expires_at),
        });
      }
      return claimTaskResultSchema.parse({ outcome: "refused", reason: row.reason });
    },

    async renew(rawRef, ttlSeconds = CLAIM_TTL_DEFAULT_SECONDS) {
      const ref = claimRefSchema.parse(rawRef);
      const result = await db.query("select * from public.renew_claim($1, $2, $3, $4)", [
        ref.workspaceId,
        ref.claimId,
        ref.claimToken,
        ttlSeconds,
      ]);
      const row = firstRow(result.rows, "renew_claim") as {
        outcome: string;
        reason: string | null;
        expires_at: Date | string | null;
      };
      if (row.outcome === "renewed") {
        return renewClaimResultSchema.parse({
          outcome: "renewed",
          expiresAt: toDate(row.expires_at),
        });
      }
      return renewClaimResultSchema.parse({ outcome: "refused", reason: row.reason });
    },

    async release(rawRef, rawReason = "released") {
      const ref = claimRefSchema.parse(rawRef);
      const reason = claimReleaseReasonSchema.parse(rawReason);
      const result = await db.query("select * from public.release_claim($1, $2, $3, $4)", [
        ref.workspaceId,
        ref.claimId,
        ref.claimToken,
        reason,
      ]);
      const row = firstRow(result.rows, "release_claim") as {
        outcome: string;
        reason: string | null;
      };
      if (row.outcome === "refused") {
        return releaseClaimResultSchema.parse({ outcome: "refused", reason: row.reason });
      }
      return releaseClaimResultSchema.parse({ outcome: row.outcome });
    },

    async sweepExpired(workspaceId) {
      const result = await db.query("select public.sweep_expired_claims($1) as freed", [
        workspaceId ?? null,
      ]);
      const row = firstRow(result.rows, "sweep_expired_claims") as { freed: number | string };
      return Number(row.freed);
    },
  };
}
