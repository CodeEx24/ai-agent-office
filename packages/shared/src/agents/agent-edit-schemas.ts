import { z } from "zod";

import {
  agentDailyBudgetSchema,
  agentModelSchema,
  agentNameSchema,
  agentPromptSchema,
  agentRoleSchema,
} from "./agent-schemas.js";
import { AGENT_MESSAGES, AGENT_THINKING_EFFORT_IDS } from "./agent-limits.js";

/**
 * Edit, duplicate, archive and unarchive an agent (AGO-89). Every schema is a strict object with no `mode`,
 * `status`, `tier`, `archivedAt` or `changedBy` field: an owner can change only the six editable settings,
 * and the database stamps the rest. The version an edit was based on is the only version-like input
 * (optimistic lock: a stale edit is refused, not merged).
 */

export const agentThinkingEffortSchema = z.enum(AGENT_THINKING_EFFORT_IDS, {
  error: (issue) =>
    issue.input === undefined || issue.input === ""
      ? AGENT_MESSAGES.thinkingEffortRequired
      : AGENT_MESSAGES.thinkingEffortUnknown,
});

/** The version number the form was loaded with, sent as text. */
export const agentExpectedVersionSchema = z
  .string("Version is missing. Reload the page and try again.")
  .regex(/^[1-9]\d{0,8}$/, "Version is invalid. Reload the page and try again.")
  .transform(Number);

export const updateAgentSchema = z.strictObject({
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  expectedVersion: agentExpectedVersionSchema,
  name: agentNameSchema,
  role: agentRoleSchema,
  model: agentModelSchema,
  thinkingEffort: agentThinkingEffortSchema,
  prompt: agentPromptSchema,
  dailyBudget: agentDailyBudgetSchema,
});
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

/** Which agent: archive and unarchive take nothing else. */
export const agentRefSchema = z.strictObject({
  workspaceId: z.uuid(),
  agentId: z.uuid(),
});
export type AgentRefInput = z.infer<typeof agentRefSchema>;

/** A copy needs a new name; the database picks the rest (Strict mode, skills and capabilities of the source). */
export const duplicateAgentSchema = z.strictObject({
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  name: agentNameSchema,
});
export type DuplicateAgentInput = z.infer<typeof duplicateAgentSchema>;

/** What a version row records. Edits to skills or capabilities are not versioned here (out of scope). */
export const AGENT_CHANGE_KINDS = ["create", "edit", "archive", "unarchive"] as const;
export type AgentChangeKind = (typeof AGENT_CHANGE_KINDS)[number];

/** The editable settings, as written in `changedFields` of a version. */
export const AGENT_EDITABLE_FIELDS = [
  "name",
  "role",
  "model",
  "thinking_effort",
  "prompt",
  "daily_budget_cents",
] as const;
export type AgentEditableField = (typeof AGENT_EDITABLE_FIELDS)[number];

/**
 * What the version trigger may list in `changedFields`: the editable settings, plus `archived_at` on an
 * archive or unarchive row (the trigger records it; it is not editable).
 */
export type AgentVersionChangedField = AgentEditableField | "archived_at";

/** One immutable row of an agent's history. It doubles as the audit log: who changed what, and when. */
export interface AgentVersion {
  version: number;
  changeKind: AgentChangeKind;
  changedFields: AgentVersionChangedField[];
  name: string;
  role: string;
  model: string;
  thinkingEffort: string;
  prompt: string;
  dailyBudgetCents: number | null;
  changedByName: string | null;
  createdAt: string;
}
