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

/**
 * The one shape of database call this module makes. The generated database types learn the two functions when the
 * kill switch migration lands (`pnpm db:types`); until then the call is typed here, narrowly, so nothing else is
 * loosened.
 */
interface KillSwitchRpcClient {
  rpc(
    fn: "activate_kill_switch" | "release_kill_switch",
    args: { p_workspace_id: string; p_scope: string; p_agent_id: string | null },
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

async function callKillSwitch(
  fn: "activate_kill_switch" | "release_kill_switch",
  input: KillSwitchBody,
): Promise<KillSwitchResult> {
  const { workspaceId } = await requireWorkspaceRole(input.workspace_id, "owner");
  const supabase = (await createSupabaseServerClient()) as unknown as KillSwitchRpcClient;
  const { data, error } = await supabase.rpc(fn, {
    p_workspace_id: workspaceId,
    p_scope: input.scope,
    p_agent_id: input.agent_id ?? null,
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
