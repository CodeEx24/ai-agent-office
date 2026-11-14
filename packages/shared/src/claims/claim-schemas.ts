import { z } from "zod";

/**
 * Task claims with expiry (AGO-160). One agent owns a task at a time; a claim that is not renewed expires.
 * The database decides (see `claim_task` and friends): expiry uses the database clock, and the claim token is
 * the fence that stops the old holder of a taken-over claim. These schemas validate what the worker sends and
 * what it reads back, so a bad value never reaches a statement.
 */
export const CLAIM_TTL_MIN_SECONDS = 10;
export const CLAIM_TTL_MAX_SECONDS = 3600;
export const CLAIM_TTL_DEFAULT_SECONDS = 300;

const ttlSecondsSchema = z.number().int().min(CLAIM_TTL_MIN_SECONDS).max(CLAIM_TTL_MAX_SECONDS);

/** Why `claim_task` said no. Mirrors the reasons the SQL function returns. */
export const CLAIM_REFUSAL_REASONS = [
  "invalid_ttl",
  "task_not_found",
  "agent_not_found",
  "workspace_mismatch",
  "agent_archived",
  "run_mismatch",
] as const;
export const claimRefusalReasonSchema = z.enum(CLAIM_REFUSAL_REASONS);
export type ClaimRefusalReason = z.infer<typeof claimRefusalReasonSchema>;

/** Why a renew or a release was refused. `stale_token` and `claim_expired` mean the caller lost the claim. */
export const CLAIM_FENCE_REASONS = [
  "invalid_ttl",
  "invalid_reason",
  "claim_not_found",
  "stale_token",
  "claim_released",
  "claim_expired",
] as const;
export const claimFenceReasonSchema = z.enum(CLAIM_FENCE_REASONS);
export type ClaimFenceReason = z.infer<typeof claimFenceReasonSchema>;

export const claimTaskInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  taskId: z.uuid(),
  agentId: z.uuid(),
  runId: z.uuid().nullable().default(null),
  ttlSeconds: ttlSecondsSchema.default(CLAIM_TTL_DEFAULT_SECONDS),
});
export type ClaimTaskInput = z.input<typeof claimTaskInputSchema>;

/** A live claim as its holder sees it: the token is the proof, keep it in memory and never log it. */
export const claimRefSchema = z.strictObject({
  workspaceId: z.uuid(),
  claimId: z.uuid(),
  claimToken: z.uuid(),
});
export type ClaimRef = z.infer<typeof claimRefSchema>;

export const claimTaskResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    claimId: z.uuid(),
    claimToken: z.uuid(),
    expiresAt: z.date(),
  }),
  z.strictObject({
    outcome: z.literal("held"),
    holderAgentId: z.uuid(),
    expiresAt: z.date(),
  }),
  z.strictObject({
    outcome: z.literal("refused"),
    reason: claimRefusalReasonSchema,
  }),
]);
export type ClaimTaskResult = z.infer<typeof claimTaskResultSchema>;

export const renewClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("renewed"), expiresAt: z.date() }),
  z.strictObject({ outcome: z.literal("refused"), reason: claimFenceReasonSchema }),
]);
export type RenewClaimResult = z.infer<typeof renewClaimResultSchema>;

export const CLAIM_RELEASE_REASONS = ["released", "completed"] as const;
export const claimReleaseReasonSchema = z.enum(CLAIM_RELEASE_REASONS);
export type ClaimReleaseReason = z.infer<typeof claimReleaseReasonSchema>;

export const releaseClaimResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["released", "completed"]) }),
  z.strictObject({ outcome: z.literal("refused"), reason: claimFenceReasonSchema }),
]);
export type ReleaseClaimResult = z.infer<typeof releaseClaimResultSchema>;
