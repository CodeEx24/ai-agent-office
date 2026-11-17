import { killSwitchResultSchema, type KillSwitchBody, type KillSwitchResult } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

/**
 * A workspace owner pulls the kill switch, or releases it (AGO-84). It only RECORDS the change: the database
 * function latches the scope, flags every live run in scope for a stop and revokes the scope's credentials; the
 * worker finishes the stops (at the next tool-call boundary, or in its control sweep). The web app never writes
 * `runs` or `run_events`.
 *
 * It runs with the caller's own session, never a service role. `public.activate_kill_switch` and
 * `public.release_kill_switch` are the real gate: a signed-in human (they refuse agent-credential claims) who is an
 * OWNER of the workspace. This code adds the same owner check so a miss is a clean 401 / 403.
 *
 * Throws `WorkspaceAccessError` (401 / 403) and `KillSwitchError` (the database call failed or answered oddly).
 */

export class KillSwitchError extends Error {
  constructor(cause?: unknown) {
    super("Could not change the kill switch.", { cause });
    this.name = "KillSwitchError";
  }
}

async function callKillSwitch(
  fn: "activate_kill_switch" | "release_kill_switch",
  input: KillSwitchBody,
): Promise<KillSwitchResult> {
  const { workspaceId } = await requireWorkspaceRole(input.workspace_id, "owner");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, {
    p_workspace_id: workspaceId,
    p_scope: input.scope,
    // Omitted for a workspace scope: the SQL parameter defaults to null.
    p_agent_id: input.agent_id,
  });
  if (error) throw new KillSwitchError(error);
  const parsed = killSwitchResultSchema.safeParse(data);
  if (!parsed.success) throw new KillSwitchError(parsed.error);
  return parsed.data;
}

export const activateKillSwitch = (input: KillSwitchBody): Promise<KillSwitchResult> =>
  callKillSwitch("activate_kill_switch", input);

export const releaseKillSwitch = (input: KillSwitchBody): Promise<KillSwitchResult> =>
  callKillSwitch("release_kill_switch", input);
