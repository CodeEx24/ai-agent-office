import { APPROVAL_STATUS } from "@ago/shared";

import type { StoredApproval } from "./approval-store.js";

/** Why a call that needed approval was closed without running. Every one of these is a denial. */
export interface ApprovalRefusal {
  readonly errorCode: string;
  readonly message: string;
  readonly text: string;
}

export const APPROVAL_REFUSAL = {
  notGranted: {
    errorCode: "approval_not_granted",
    message: "no approval was recorded for this call",
    text: "The tool call needed a human approval that was not given. It was not run.",
  },
  expired: {
    errorCode: "approval_expired",
    message: "the approval request expired",
    text: "The approval request for this tool call expired before a human answered. It was not run.",
  },
  denied: {
    errorCode: "approval_denied",
    message: "a human denied the approval request",
    text: "A human denied this tool call. It was not run.",
  },
  payloadMismatch: {
    errorCode: "approval_payload_mismatch",
    message: "the call differs from the one that was approved",
    text: "The approval was given for a different tool call than this one. It was not run.",
  },
  alreadyUsed: {
    errorCode: "approval_already_used",
    message: "the approval was already used",
    text: "The approval for this tool call was already used and cannot be used again. It was not run.",
  },
} as const satisfies Record<string, ApprovalRefusal>;

/**
 * The specific reason a call is not granted by this row, for the model and the audit trail. Pure: it only
 * reads the row. `expectedHash` is the hash of the exact call about to run, computed by the worker. A null row,
 * or a row in an unexpected state, is plain "not granted": the answer is always a denial, never a pass.
 */
export function describeApprovalRefusal(
  approval: StoredApproval | null,
  expectedHash: string,
  nowMs: number,
): ApprovalRefusal {
  if (approval === null) return APPROVAL_REFUSAL.notGranted;
  if (approval.status === APPROVAL_STATUS.denied) return APPROVAL_REFUSAL.denied;
  if (approval.status === APPROVAL_STATUS.rejected) return APPROVAL_REFUSAL.expired;
  const isPastLimit = approval.expiresAt.getTime() <= nowMs;
  if (approval.status === APPROVAL_STATUS.pending) {
    return isPastLimit ? APPROVAL_REFUSAL.expired : APPROVAL_REFUSAL.notGranted;
  }
  if (approval.status !== APPROVAL_STATUS.approved) return APPROVAL_REFUSAL.notGranted;
  // Approved. A changed payload is the most serious thing to report, so it comes before used and expired.
  if (approval.payloadHash !== expectedHash) return APPROVAL_REFUSAL.payloadMismatch;
  if (approval.consumedAt !== null) return APPROVAL_REFUSAL.alreadyUsed;
  if (isPastLimit) return APPROVAL_REFUSAL.expired;
  return APPROVAL_REFUSAL.notGranted;
}
