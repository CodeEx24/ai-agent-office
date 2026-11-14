import "server-only";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import { AgentModeError, type AgentModeEditor } from "./promote-agent";

interface RpcError {
  code?: string;
}

/** The slice of the Supabase client this file uses: one RPC call that returns an error or nothing. */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: RpcError | null }>;
}

/**
 * SQLSTATE codes `set_agent_mode` raises (draft: docs/tickets/AGO-99-migration-draft.sql): 42501 not an
 * owner, P0002 no such agent in this workspace, 55000 the agent is archived, AGM01 the agent is already in
 * that mode, 22023 a mode the database refuses. Anything else is a failure whose text is never shown.
 */
function toModeError(error: RpcError): AgentModeError {
  switch (error.code) {
    case "42501":
      return new AgentModeError("forbidden");
    case "P0002":
      return new AgentModeError("not_found");
    case "55000":
      return new AgentModeError("archived");
    case "AGM01":
      return new AgentModeError("unchanged");
    case "22023":
      return new AgentModeError("invalid");
    default:
      return new AgentModeError("failed");
  }
}

/**
 * The real editor. It requires the owner role, then makes ONE database call: the function changes the mode and
 * appends the `agent_mode_changes` row in the same transaction, so a mode never changes without a log entry.
 * The function runs with the caller's rights (SECURITY INVOKER) and an agent credential has no signed-in
 * member, so the database refuses it as well. Who changed it and when are stamped by the database, never sent
 * from here.
 */
export const agentModeEditor: AgentModeEditor = {
  async setAgentMode(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    const supabase = (await createSupabaseServerClient()) as unknown as RpcClient;
    const { error } = await supabase.rpc("set_agent_mode", {
      p_workspace_id: access.workspaceId,
      p_agent_id: input.agentId,
      p_mode: input.mode,
    });
    if (error) throw toModeError(error);
  },
};
