import "server-only";

import {
  skillAssignmentSchema,
  skillSchema,
  skillVersionSchema,
  type AssignSkillInput,
  type CreateSkillInput,
  type SaveSkillInput,
  type Skill,
  type SkillAssignment,
  type SkillVersion,
} from "@ago/shared";

import { createSupabaseServerClient } from "../../lib/supabase/server";
import { requireWorkspaceRole } from "../workspaces/workspace-access";

const SKILL_COLUMNS = "id, workspace_id, name, description, body, version, created_at, updated_at";
const VERSION_COLUMNS = "id, skill_id, version, body, created_by, created_at";

export type SkillLibraryErrorCode = "not_found" | "name_taken" | "stale" | "failed";

/** Thrown when a skill cannot be read or saved. Carries a code, never row data. */
export class SkillLibraryError extends Error {
  constructor(readonly code: SkillLibraryErrorCode) {
    super(`Skill library error: ${code}`);
    this.name = "SkillLibraryError";
  }
}

export interface AssignableAgent {
  id: string;
  name: string;
}

export interface SkillDetail {
  skill: Skill;
  /** Newest first. Every version ever saved; none is ever changed or removed. */
  versions: SkillVersion[];
  /** Agents the skill is assigned to. An assignment follows the latest version. */
  assignments: SkillAssignment[];
  /** Active agents in the workspace, for the assign control. */
  agents: AssignableAgent[];
}

interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  body: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function toSkill(row: SkillRow): Skill {
  const parsed = skillSchema.safeParse({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    body: row.body,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) throw new SkillLibraryError("failed");
  return parsed.data;
}

/** Postgres unique violation (workspace_id, name). */
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

/** Every skill in the workspace, by name. Members and viewers may read. */
export async function listSkills(workspaceId: string): Promise<Skill[]> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("skills")
    .select(SKILL_COLUMNS)
    .eq("workspace_id", access.workspaceId)
    .order("name", { ascending: true });
  if (error) throw new SkillLibraryError("failed");
  return data.map(toSkill);
}

/** One skill with its full version history, assignments and the agents it could be assigned to. */
export async function getSkillDetail(workspaceId: string, skillId: string): Promise<SkillDetail> {
  const access = await requireWorkspaceRole(workspaceId, "viewer");
  const supabase = await createSupabaseServerClient();

  const skillResult = await supabase
    .from("skills")
    .select(SKILL_COLUMNS)
    .eq("workspace_id", access.workspaceId)
    .eq("id", skillId)
    .maybeSingle();
  if (skillResult.error) throw new SkillLibraryError("failed");
  if (!skillResult.data) throw new SkillLibraryError("not_found");

  const [versionsResult, assignedResult, agentsResult] = await Promise.all([
    supabase
      .from("skill_versions")
      .select(VERSION_COLUMNS)
      .eq("workspace_id", access.workspaceId)
      .eq("skill_id", skillId)
      .order("version", { ascending: false }),
    supabase
      .from("agent_skills")
      .select("agent_id, agents!inner(name)")
      .eq("workspace_id", access.workspaceId)
      .eq("skill_id", skillId),
    supabase
      .from("agents")
      .select("id, name")
      .eq("workspace_id", access.workspaceId)
      .is("archived_at", null)
      .order("name", { ascending: true }),
  ]);
  if (versionsResult.error || assignedResult.error || agentsResult.error) {
    throw new SkillLibraryError("failed");
  }

  const versions = versionsResult.data.map((row) => {
    const parsed = skillVersionSchema.safeParse({
      id: row.id,
      skillId: row.skill_id,
      version: row.version,
      body: row.body,
      createdBy: row.created_by,
      createdAt: row.created_at,
    });
    if (!parsed.success) throw new SkillLibraryError("failed");
    return parsed.data;
  });

  const assignments = assignedResult.data
    .map((row) => {
      const parsed = skillAssignmentSchema.safeParse({
        agentId: row.agent_id,
        agentName: row.agents.name,
      });
      if (!parsed.success) throw new SkillLibraryError("failed");
      return parsed.data;
    })
    .sort((a, b) => a.agentName.localeCompare(b.agentName));

  return {
    skill: toSkill(skillResult.data),
    versions,
    assignments,
    agents: agentsResult.data,
  };
}

/** Creates a skill (version 1). Owners only; the database enforces the same rule. */
export async function createSkill(input: CreateSkillInput): Promise<{ id: string }> {
  const access = await requireWorkspaceRole(input.workspaceId, "owner");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("skills")
    .insert({
      workspace_id: access.workspaceId,
      name: input.name,
      description: input.description,
      body: input.body,
    })
    .select("id")
    .single();
  if (error) throw new SkillLibraryError(isUniqueViolation(error) ? "name_taken" : "failed");
  return { id: data.id };
}

/**
 * Saves an edit. A changed text stores a new version (a database trigger appends it and moves the
 * skill to it); the old versions stay. `expectedVersion` makes a stale editor fail instead of
 * overwriting a newer save. Owners only.
 */
export async function saveSkill(input: SaveSkillInput): Promise<{ version: number }> {
  const access = await requireWorkspaceRole(input.workspaceId, "owner");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("skills")
    .update({ description: input.description, body: input.body })
    .eq("workspace_id", access.workspaceId)
    .eq("id", input.skillId)
    .eq("version", input.expectedVersion)
    .select("version");
  if (error) throw new SkillLibraryError("failed");
  const updated = data[0];
  if (!updated) {
    // Zero rows: the skill is gone, or someone saved a newer version first.
    const exists = await supabase
      .from("skills")
      .select("id")
      .eq("workspace_id", access.workspaceId)
      .eq("id", input.skillId)
      .maybeSingle();
    throw new SkillLibraryError(exists.data ? "stale" : "not_found");
  }
  return { version: updated.version };
}

/** Assigns a skill to an agent. Owners only. Assigning twice is a no-op. */
export async function assignSkill(input: AssignSkillInput): Promise<void> {
  const access = await requireWorkspaceRole(input.workspaceId, "owner");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("agent_skills").insert({
    workspace_id: access.workspaceId,
    agent_id: input.agentId,
    skill_id: input.skillId,
  });
  if (error && !isUniqueViolation(error)) throw new SkillLibraryError("failed");
}

/** Removes a skill from an agent. Owners only. The skill and its versions are untouched. */
export async function unassignSkill(input: AssignSkillInput): Promise<void> {
  const access = await requireWorkspaceRole(input.workspaceId, "owner");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("agent_skills")
    .delete()
    .eq("workspace_id", access.workspaceId)
    .eq("agent_id", input.agentId)
    .eq("skill_id", input.skillId);
  if (error) throw new SkillLibraryError("failed");
}
