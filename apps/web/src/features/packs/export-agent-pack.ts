import {
  PackExportError,
  buildAgentPack,
  type BuiltAgentPack,
  type PackSourceAgent,
  type PackSourceSkill,
} from "@ago/shared/pack-export";
import { capabilityScopeSchema, packThinkingEffortSchema, type Database } from "@ago/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Agent pack export, the data path (AGO-192). One function serves the API route and `pnpm pack:export`.
 *
 * It takes the caller's own Supabase client, so every read goes through row-level security as that person:
 * there is no service-role path here, on purpose (a test greps this folder for it). It selects named columns
 * only, never `select *`, and never reads credentials, identities, run limits, runs or budget usage, so those
 * cannot reach a pack even by mistake. This file has no `server-only` import because the CLI runs it too; the
 * route does the role check and passes in a request-scoped client.
 *
 * The export is logged by `record_pack_export` BEFORE the file is returned: a failed log means no file.
 */

export type ExportFailureCode = "not_found" | "no_agents" | "invalid_pack" | "forbidden" | "failed";

/** Thrown when an export cannot complete. Carries a code and nothing from the rows. */
export class ExportAgentPackError extends Error {
  // An explicit field, not a parameter property: the CLI runs this file with Node's type stripping,
  // which cannot erase parameter properties.
  readonly code: ExportFailureCode;

  constructor(code: ExportFailureCode) {
    super(`Agent pack export failed: ${code}`);
    this.name = "ExportAgentPackError";
    this.code = code;
  }
}

export interface ExportAgentPackInput {
  workspaceId: string;
  /** Omitted: every active (non-archived) agent. Given: exactly these agents. */
  agentIds?: readonly string[];
  name?: string;
  /** Injected for tests; defaults to now. */
  now?: Date;
  appVersion?: string;
}

export interface ExportedAgentPack extends BuiltAgentPack {
  /** The pack_events row that logged this export. */
  eventId: string;
  /** A safe download name; contains no workspace or agent names. */
  fileName: string;
}

export const DEFAULT_PACK_NAME = "Agent pack";
const DEFAULT_APP_VERSION = "0.1.0";
/** Postgres: insufficient_privilege, raised by record_pack_export for a viewer or non-member. */
const INSUFFICIENT_PRIVILEGE = "42501";

type Client = SupabaseClient<Database>;

function fail(code: ExportFailureCode): never {
  throw new ExportAgentPackError(code);
}

export async function exportAgentPack(
  client: Client,
  input: ExportAgentPackInput,
): Promise<ExportedAgentPack> {
  const { workspaceId } = input;
  const requestedIds = [...new Set(input.agentIds ?? [])];

  const agentQuery = client
    .from("agents")
    .select("id, name, role, model, thinking_effort, prompt, mode, daily_budget_cents, archived_at")
    .eq("workspace_id", workspaceId);
  const { data: agentRows, error: agentError } = await (
    input.agentIds ? agentQuery.in("id", requestedIds) : agentQuery.is("archived_at", null)
  ).order("name", { ascending: true });
  if (agentError) fail("failed");
  if (input.agentIds && agentRows.length !== requestedIds.length) fail("not_found");
  if (agentRows.length === 0) fail("no_agents");
  const agentIds = agentRows.map((row) => row.id);

  const [links, grants] = await Promise.all([
    client
      .from("agent_skills")
      .select("agent_id, skill_id")
      .eq("workspace_id", workspaceId)
      .in("agent_id", agentIds),
    client
      .from("agent_capabilities")
      .select("agent_id, capability")
      .eq("workspace_id", workspaceId)
      .in("agent_id", agentIds),
  ]);
  if (links.error || grants.error) fail("failed");

  const skillIds = [...new Set(links.data.map((link) => link.skill_id))];
  const capabilityKeys = [...new Set(grants.data.map((grant) => grant.capability))];
  const [skillRows, catalogRows] = await Promise.all([
    skillIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client
          .from("skills")
          .select("id, name, version, body")
          .eq("workspace_id", workspaceId)
          .in("id", skillIds),
    capabilityKeys.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client
          .from("capabilities")
          .select("key, scope")
          .eq("workspace_id", workspaceId)
          .in("key", capabilityKeys),
  ]);
  if (skillRows.error || catalogRows.error) fail("failed");

  const skillById = new Map(skillRows.data.map((skill) => [skill.id, skill]));
  const scopeByKey = new Map(catalogRows.data.map((row) => [row.key, row.scope]));

  const agents: PackSourceAgent[] = agentRows.map((row) => {
    const effort = packThinkingEffortSchema.safeParse(row.thinking_effort);
    if (!effort.success) fail("invalid_pack");
    const skillNames = links.data
      .filter((link) => link.agent_id === row.id)
      .map((link) => skillById.get(link.skill_id)?.name);
    const skills = skillNames.filter((name): name is string => name !== undefined);
    if (skills.length !== skillNames.length) fail("failed");
    const capabilities = grants.data
      .filter((grant) => grant.agent_id === row.id)
      .map((grant) => {
        const scope = capabilityScopeSchema.safeParse(scopeByKey.get(grant.capability));
        // A grant whose catalog row is gone has no scope to export: refuse rather than guess.
        if (!scope.success) fail("invalid_pack");
        return { key: grant.capability, scope: scope.data };
      });
    return {
      name: row.name,
      role: row.role,
      model: row.model,
      thinkingEffort: effort.data,
      prompt: row.prompt,
      mode: row.mode,
      dailyBudgetCents: row.daily_budget_cents,
      skills,
      capabilities,
    };
  });
  const skills: PackSourceSkill[] = skillRows.data.map((skill) => ({
    name: skill.name,
    version: skill.version,
    body: skill.body,
  }));

  let built: BuiltAgentPack;
  try {
    built = buildAgentPack(
      { agents, skills },
      {
        name: input.name ?? DEFAULT_PACK_NAME,
        now: input.now ?? new Date(),
        appVersion: input.appVersion ?? DEFAULT_APP_VERSION,
      },
    );
  } catch (error) {
    if (error instanceof PackExportError) {
      fail(error.code === "no_agents" ? "no_agents" : "invalid_pack");
    }
    throw error;
  }

  // The export is logged before the file leaves: no event, no file. The database pins the exporter to the
  // caller and takes the agent names from its own table.
  const { data: eventId, error: eventError } = await client.rpc("record_pack_export", {
    p_workspace_id: workspaceId,
    p_agent_ids: agentIds,
    p_skill_count: built.pack.skills.length,
    p_checksum: built.checksum,
  });
  if (eventError) fail(eventError.code === INSUFFICIENT_PRIVILEGE ? "forbidden" : "failed");

  return { ...built, eventId, fileName: `agent-pack-${built.checksum.slice(0, 12)}.json` };
}
