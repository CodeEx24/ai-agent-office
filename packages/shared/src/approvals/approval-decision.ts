import { z } from "zod";

/**
 * The human decision on an approval (AGO-58): the body of `POST /api/approvals/[id]/decision` and the rule for
 * what can satisfy a gate. Pure schemas and one predicate: no I/O.
 */

export const APPROVAL_DECISIONS = ["approved", "denied"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `.strict()`: a client cannot send a `payload_hash`, `status` or anything else. The hash stays what the runtime stored. */
export const decideApprovalBodySchema = z
  .object({
    workspace_id: z.uuid(),
    decision: z.enum(APPROVAL_DECISIONS),
  })
  .strict();
export type DecideApprovalBody = z.infer<typeof decideApprovalBodySchema>;

export const approvalIdParamSchema = z.uuid();

/** Who or what produced an answer about an approval. Only a person's decision can satisfy a gate. */
export const APPROVAL_VERDICT_SOURCES = [
  "human",
  "reviewer_agent",
  "agent",
  "policy",
  "timeout",
] as const;
export type ApprovalVerdictSource = (typeof APPROVAL_VERDICT_SOURCES)[number];

/**
 * A Reviewer agent's verdict (AGO-140, later) is advice for the human who decides. It never satisfies a Tier 3 or
 * Tier 4 gate: the one thing that does is a human `approved` decision, and even that only unlocks the exact call
 * whose payload hash it was given for (AGO-47).
 */
export const REVIEWER_VERDICT_IS_ADVISORY = true as const;

export function satisfiesApprovalGate(answer: {
  readonly source: ApprovalVerdictSource;
  readonly status: string;
}): boolean {
  return answer.source === "human" && answer.status === "approved";
}
