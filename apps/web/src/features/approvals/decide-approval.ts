import { APPROVAL_STATUS, type ApprovalDecision } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

/**
 * The human decision on an approval (AGO-58). The one place the web app writes `approved` or `denied`; the file is
 * listed in `HUMAN_DECISION_FILES` in `no-auto-approve.test.ts` so the exception shows up in review.
 *
 * It runs with the caller's own session (RLS), never a service role. The database policy `approvals_update_member`
 * is the real gate: member role, status `pending`, not consumed, not past `expires_at`, the new status is
 * `approved` or `denied`, and `decided_by` is the caller's own membership. This code adds the same filters so a
 * miss is a clean `not_decidable`, and writes ONLY `status`, `decided_by` and `decided_at`: `payload_hash`,
 * `action`, `run_id` and `expires_at` are not in the table grant and are never sent, so the approval stays bound
 * to the hash the runtime stored (AGO-47).
 *
 * Throws `WorkspaceAccessError` (401 / 403) when the caller is signed out or not a member.
 */

export type DecideApprovalResult =
  | { readonly outcome: "decided"; readonly id: string; readonly status: ApprovalDecision }
  | { readonly outcome: "not_decidable" };

export class ApprovalDecisionError extends Error {
  constructor(cause?: unknown) {
    super("Could not record the decision.", { cause });
    this.name = "ApprovalDecisionError";
  }
}

export async function decideApproval(input: {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly decision: ApprovalDecision;
}): Promise<DecideApprovalResult> {
  const { userId, workspaceId } = await requireWorkspaceRole(input.workspaceId, "member");
  const supabase = await createSupabaseServerClient();

  const member = await supabase
    .from("members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .is("removed_at", null)
    .maybeSingle();
  if (member.error) throw new ApprovalDecisionError(member.error);
  if (!member.data) return { outcome: "not_decidable" };

  const updated = await supabase
    .from("approvals")
    .update({
      status: input.decision,
      decided_by: member.data.id,
      decided_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", input.approvalId)
    .eq("status", APPROVAL_STATUS.pending)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id, status")
    .maybeSingle();
  if (updated.error) throw new ApprovalDecisionError(updated.error);
  if (!updated.data) return { outcome: "not_decidable" };
  return { outcome: "decided", id: updated.data.id, status: input.decision };
}
