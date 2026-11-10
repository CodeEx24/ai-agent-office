import "server-only";

import { isAgentModelId } from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import { AgentEditError, type AgentEditor } from "./edit-agent";

interface RpcError {
  code?: string;
  message?: string;
}

/** The slice of the Supabase client this file uses: one RPC call that returns data or an error. */
interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/**
 * SQLSTATE codes the AGO-89 functions raise (see the migration): 42501 not an owner, 23505 name taken,
 * P0002 no such agent in this workspace, 40001 the edit was based on an old version, 55000 the agent is
 * archived, 22023 a value the database refuses. Anything else is a failure whose text is never shown.
 */
function toEditError(error: RpcError): AgentEditError {
  switch (error.code) {
    case "42501":
      return new AgentEditError("forbidden");
    case "23505":
      return new AgentEditError("name_taken", "name");
    case "P0002":
      return new AgentEditError("not_found");
    case "40001":
      return new AgentEditError("stale");
    case "55000":
      return new AgentEditError("archived");
    case "22023":
      return new AgentEditError(
        "invalid",
        /budget/i.test(error.message ?? "") ? "dailyBudget" : undefined,
      );
    default:
      return new AgentEditError("failed");
  }
}

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const supabase = (await createSupabaseServerClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toEditError(error);
  return data;
}

/**
 * The real editor. Every method requires the owner role first, then makes ONE database call: the function
 * changes the agent and the trigger writes the version row in the same transaction, so there is no way to
 * edit an agent without leaving a version. The functions run with the caller's rights (SECURITY INVOKER), so
 * row-level security and the owner policies still apply. `mode`, `status` and the version stamp are never
 * sent from here: the database owns them.
 */
export const agentEditor: AgentEditor = {
  async updateAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    // AGO-94: the database does not check the model (the allowlist changes without a migration).
    if (!isAgentModelId(input.model)) {
      throw new AgentEditError("invalid", "model");
    }
    const data = await call("update_agent", {
      p_workspace_id: access.workspaceId,
      p_agent_id: input.agentId,
      p_expected_version: input.expectedVersion,
      p_name: input.name,
      p_role: input.role,
      p_model: input.model,
      p_thinking_effort: input.thinkingEffort,
      p_prompt: input.prompt,
      p_daily_budget_cents: input.dailyBudget,
    });
    if (typeof data !== "number") throw new AgentEditError("failed");
    return { version: data };
  },

  async duplicateAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    const data = await call("duplicate_agent", {
      p_workspace_id: access.workspaceId,
      p_agent_id: input.agentId,
      p_name: input.name,
    });
    if (typeof data !== "string") throw new AgentEditError("failed");
    return { id: data };
  },

  async archiveAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    await call("archive_agent", { p_workspace_id: access.workspaceId, p_agent_id: input.agentId });
  },

  async unarchiveAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");
    await call("unarchive_agent", {
      p_workspace_id: access.workspaceId,
      p_agent_id: input.agentId,
    });
  },
};
