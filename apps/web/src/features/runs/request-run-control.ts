import { runControlResultSchema, type RunControlAction } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

/**
 * A person asks to pause, resume or stop a run (AGO-86). It only RECORDS the request: the worker finishes it at the
 * next tool-call boundary (or, for a queued or paused run, in its control sweep), so the web app never writes
 * `runs` or `run_events`.
 *
 * It runs with the caller's own session, never a service role. `public.request_run_control` is the real gate: a
 * signed-in human (it refuses agent-credential claims), a member of the workspace, and a run in a state that action
 * can reach. This code adds the same member check so a miss is a clean 401 / 403.
 *
 * Throws `WorkspaceAccessError` (401 / 403) and `RunControlError` (the database call failed).
 */

export type RequestRunControlResult = "accepted" | "not_applicable";

export class RunControlError extends Error {
  constructor(cause?: unknown) {
    super("Could not record the control request.", { cause });
    this.name = "RunControlError";
  }
}

export async function requestRunControl(input: {
  readonly runId: string;
  readonly workspaceId: string;
  readonly action: RunControlAction;
}): Promise<RequestRunControlResult> {
  const { workspaceId } = await requireWorkspaceRole(input.workspaceId, "member");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_run_control", {
    p_workspace_id: workspaceId,
    p_run_id: input.runId,
    p_action: input.action,
  });
  if (error) throw new RunControlError(error);
  const parsed = runControlResultSchema.safeParse(data);
  if (!parsed.success) throw new RunControlError(parsed.error);
  return parsed.data;
}
