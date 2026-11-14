/**
 * Approval request states (AGO-21). `public.approvals.status` is free text (AGO-74), so the values live here.
 *
 * - `pending`: raised by the runtime, waiting for a human.
 * - `approved` / `denied`: set by a human through RLS (AGO-107); only a human can write these.
 * - `rejected`: set by the runtime when a pending request passes `expires_at` (timeout means deny).
 *   The run event for it is `approval.decided` with outcome `expired`.
 *
 * Only `approved` can ever let a call run, and even that is gated by AGO-47 (payload hash, single use).
 */
export const APPROVAL_STATUS = {
  pending: "pending",
  approved: "approved",
  denied: "denied",
  rejected: "rejected",
} as const;

export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

/** Longest `approvals.action` (the table's check constraint). The action is the tool name, never its input. */
export const APPROVAL_ACTION_MAX_LENGTH = 200;
