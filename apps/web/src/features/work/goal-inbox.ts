import "server-only";

import type { Goal, SubmitGoalInput } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

export type GoalInboxErrorCode = "forbidden" | "invalid" | "no_manager" | "failed";

/** Thrown when a goal cannot be submitted or listed. Carries a code; the action turns it into safe copy. */
export class GoalInboxError extends Error {
  constructor(readonly code: GoalInboxErrorCode) {
    super(`Goal inbox error: ${code}`);
    this.name = "GoalInboxError";
  }
}

/** The one write the form makes. A seam so the action logic can be tested without a database. */
export interface GoalSubmitter {
  submitGoal(input: SubmitGoalInput): Promise<{ id: string }>;
}

/** How many goals the inbox lists. */
export const GOAL_LIST_LIMIT = 50;

/** Maps the SQLSTATE `submit_goal` raises (see the AGO-113 migration) to an error code. */
function toInboxError(error: { code?: string }): GoalInboxError {
  switch (error.code) {
    case "42501":
      return new GoalInboxError("forbidden");
    case "22023":
      return new GoalInboxError("invalid");
    case "P0002":
      return new GoalInboxError("no_manager");
    default:
      return new GoalInboxError("failed");
  }
}

/**
 * Submits a goal through `submit_goal` (AGO-113): the goal and the Manager's task are written in one
 * transaction. Members and owners only; the role is checked here for a clear error and again in the function,
 * which derives the caller from the session and never trusts a parameter for who they are.
 */
export const goalSubmitter: GoalSubmitter = {
  async submitGoal(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "member");
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("submit_goal", {
      p_workspace_id: access.workspaceId,
      p_text: input.text,
    });
    if (error) throw toInboxError(error);
    return { id: data };
  },
};

/** The newest goals in the workspace. Any member, including viewers, may read. */
export async function listGoals(workspaceId: string): Promise<Goal[]> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("goals")
    .select("id, text, created_at")
    .eq("workspace_id", access.workspaceId)
    .order("created_at", { ascending: false })
    .limit(GOAL_LIST_LIMIT);
  if (error) throw new GoalInboxError("failed");
  return data.map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
}
