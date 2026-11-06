import "server-only";

import {
  resolveCapabilityGrants,
  type AgentField,
  type Capability,
  type CreateAgentInput,
  type Skill,
} from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { listCapabilities } from "../capabilities/capability-catalog";
import { listSkills } from "../skills/skill-library";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

export type AgentLibraryErrorCode = "name_taken" | "invalid" | "not_found" | "forbidden" | "failed";

/** Thrown when an agent cannot be created. Carries a code, the field it belongs to, and a safe message. */
export class AgentLibraryError extends Error {
  constructor(
    readonly code: AgentLibraryErrorCode,
    readonly field?: AgentField,
    message?: string,
  ) {
    super(message ?? `Agent library error: ${code}`);
    this.name = "AgentLibraryError";
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  model: string;
  mode: string;
  dailyBudgetCents: number | null;
}

/** What the wizard offers: the owner's skill library and the enabled capabilities of the catalog. */
export interface AgentWizardOptions {
  skills: Pick<Skill, "id" | "name" | "description">[];
  capabilities: Pick<Capability, "key" | "name" | "description" | "tier" | "defaultMode">[];
}

/** The one write the wizard makes. A seam so the action can be tested without a database. */
export interface AgentCreator {
  createAgent(input: CreateAgentInput): Promise<{ id: string }>;
}

/** Active agents, by name. Members and viewers may read. */
export async function listAgents(workspaceId: string): Promise<AgentSummary[]> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, model, mode, daily_budget_cents")
    .eq("workspace_id", access.workspaceId)
    .is("archived_at", null)
    .order("name", { ascending: true });
  if (error) throw new AgentLibraryError("failed");
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    model: row.model,
    mode: row.mode,
    dailyBudgetCents: row.daily_budget_cents,
  }));
}

/** Skills and capabilities for the wizard. Owners only: it is part of the create flow. */
export async function getAgentWizardOptions(workspaceId: string): Promise<AgentWizardOptions> {
  await requireWorkspaceRole(workspaceId, "owner");
  const [skills, capabilities] = await Promise.all([
    listSkills(workspaceId),
    listCapabilities(workspaceId),
  ]);
  return {
    skills: skills.map(({ id, name, description }) => ({ id, name, description })),
    capabilities: capabilities
      .filter((capability) => capability.enabled)
      .map(({ key, name, description, tier, defaultMode }) => ({
        key,
        name,
        description,
        tier,
        defaultMode,
      })),
  };
}

interface RpcError {
  code?: string;
  message?: string;
}

function toLibraryError(error: RpcError): AgentLibraryError {
  switch (error.code) {
    case "42501":
      return new AgentLibraryError("forbidden");
    case "23505":
      return new AgentLibraryError("name_taken", "name");
    case "P0002":
      return new AgentLibraryError(
        "not_found",
        /skill/i.test(error.message ?? "") ? "skillIds" : "capabilities",
      );
    case "22023":
      return new AgentLibraryError("invalid", "capabilities");
    default:
      return new AgentLibraryError("failed");
  }
}

/**
 * Creates an agent with its skills and capability grants in ONE database transaction (`create_agent`).
 * Owners only. The agent always starts in Strict mode: the function has no way to pick another. The tier of
 * every capability is read from the catalog here and again inside the function; the request's `mode` for a
 * Tier 3 or 4 capability is refused, never lowered, so a tampered request fails instead of being accepted.
 * The function runs with the caller's rights, so row-level security and the owner policy still apply.
 */
export const agentCreator: AgentCreator = {
  async createAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");

    const catalog = await listCapabilities(access.workspaceId);
    const resolved = resolveCapabilityGrants(input.capabilities, catalog);
    if (!resolved.ok) throw new AgentLibraryError("invalid", resolved.field, resolved.message);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_agent", {
      p_workspace_id: access.workspaceId,
      p_name: input.name,
      p_role: input.role,
      p_model: input.model,
      p_prompt: input.prompt,
      p_daily_budget_cents: input.dailyBudget,
      p_skill_ids: input.skillIds,
      p_capabilities: resolved.grants.map((grant) => ({ key: grant.key, mode: grant.mode })),
    });
    if (error) throw toLibraryError(error);
    return { id: data };
  },
};
