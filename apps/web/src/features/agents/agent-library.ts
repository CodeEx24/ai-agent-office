import "server-only";

import {
  AGENT_MESSAGES,
  isAgentModelId,
  lintTrifecta,
  resolveCapabilityGrants,
  type AgentField,
  type AgentVersion,
  type Capability,
  type CreateAgentInput,
  type Skill,
} from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { listCapabilities } from "../capabilities/capability-catalog";
import { listSkills } from "../skills/skill-library";
import { requireWorkspaceRole } from "../workspaces/workspace-access";
import type { EditableAgent } from "./AgentEditForm";

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

async function listAgentsByState(
  workspaceId: string,
  isArchived: boolean,
): Promise<AgentSummary[]> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();
  const query = supabase
    .from("agents")
    .select("id, name, role, model, mode, daily_budget_cents")
    .eq("workspace_id", access.workspaceId);
  const { data, error } = await (
    isArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null)
  ).order("name", { ascending: true });
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

/** Active agents, by name. Members and viewers may read. */
export async function listAgents(workspaceId: string): Promise<AgentSummary[]> {
  return listAgentsByState(workspaceId, false);
}

/** Archived agents (AGO-89), by name. They cannot receive tasks; an owner can unarchive them. */
export async function listArchivedAgents(workspaceId: string): Promise<AgentSummary[]> {
  return listAgentsByState(workspaceId, true);
}

/** One agent's editable settings and its version history, newest first (AGO-89). Members and viewers may read. */
export async function getAgentDetail(
  workspaceId: string,
  agentId: string,
): Promise<{ agent: EditableAgent; versions: AgentVersion[]; mode: string }> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();
  const [agentResult, versionsResult, membersResult] = await Promise.all([
    supabase
      .from("agents")
      .select(
        "id, name, role, model, mode, thinking_effort, prompt, daily_budget_cents, version, archived_at",
      )
      .eq("workspace_id", access.workspaceId)
      .eq("id", agentId)
      .maybeSingle(),
    supabase
      .from("agent_versions")
      .select(
        "version, change_kind, changed_fields, name, role, model, thinking_effort, prompt, daily_budget_cents, changed_by, created_at",
      )
      .eq("workspace_id", access.workspaceId)
      .eq("agent_id", agentId)
      .order("version", { ascending: false }),
    supabase.from("members").select("id, user_id, role").eq("workspace_id", access.workspaceId),
  ]);
  if (agentResult.error || versionsResult.error || membersResult.error) {
    throw new AgentLibraryError("failed");
  }
  const row = agentResult.data;
  if (!row) throw new AgentLibraryError("not_found");

  // Members carry no display name yet: say "You" for the viewer, otherwise the role of the person.
  const memberLabel = new Map(
    membersResult.data.map((member) => [
      member.id,
      member.user_id === access.userId ? "You" : `A workspace ${member.role}`,
    ]),
  );
  const versions = versionsResult.data.map((version) => ({
    version: version.version,
    changeKind: version.change_kind as AgentVersion["changeKind"],
    changedFields: version.changed_fields as AgentVersion["changedFields"],
    name: version.name,
    role: version.role,
    model: version.model,
    thinkingEffort: version.thinking_effort,
    prompt: version.prompt,
    dailyBudgetCents: version.daily_budget_cents,
    changedByName: version.changed_by ? (memberLabel.get(version.changed_by) ?? null) : null,
    createdAt: version.created_at,
  }));
  return {
    agent: {
      id: row.id,
      name: row.name,
      role: row.role,
      model: row.model,
      thinkingEffort: row.thinking_effort,
      prompt: row.prompt,
      dailyBudgetCents: row.daily_budget_cents,
      version: row.version,
      isArchived: row.archived_at !== null,
    },
    versions,
    mode: row.mode,
  };
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
 * A capability set that holds all three legs of the trifecta (AGO-138) is refused too, here only (see below).
 * The function runs with the caller's rights, so row-level security and the owner policy still apply.
 */
export const agentCreator: AgentCreator = {
  async createAgent(input) {
    const access = await requireWorkspaceRole(input.workspaceId, "owner");

    // AGO-94: the RPC does not check the model (a DB CHECK needs a migration; see docs/tickets/AGO-94.md),
    // so refuse an unknown one here, before the call, whatever path got us here.
    if (!isAgentModelId(input.model)) {
      throw new AgentLibraryError("invalid", "model", AGENT_MESSAGES.modelUnknown);
    }

    const catalog = await listCapabilities(access.workspaceId);
    const resolved = resolveCapabilityGrants(input.capabilities, catalog);
    if (!resolved.ok) throw new AgentLibraryError("invalid", resolved.field, resolved.message);

    // AGO-138: untrusted content + private data + outbound communication is blocked (no override yet). Both app
    // create paths (wizard, create-from-template) go through here, so the UI cannot skip it. This is an app-level
    // check only: the create_agent RPC and direct inserts into agent_capabilities are not covered (DB backstop follow-up).
    const trifecta = lintTrifecta(resolved.grants.map((grant) => grant.key));
    if (!trifecta.ok) throw new AgentLibraryError("invalid", "capabilities", trifecta.message);

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
