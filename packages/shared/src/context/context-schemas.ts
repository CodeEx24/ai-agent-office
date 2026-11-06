import { z } from "zod";

import {
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from "../skills/skill-limits.js";

/**
 * Run context (AGO-145). The worker's context builder turns one run into `{ system, messages, metadata }`
 * for the agent tool loop (AGO-167). These schemas are the shape of the inputs it accepts and of what it
 * returns. No model is called here.
 *
 * Trust model: `system` holds only trusted text (platform rules, the agent profile, skills an owner wrote).
 * Everything else (task text, imported skill text, vault paths and titles, retrieved content) is wrapped as
 * labeled untrusted data in the user message.
 */

/** Default size cap for one built context, in characters (about 12,000 tokens at 4 characters per token). */
export const DEFAULT_CONTEXT_MAX_CHARS = 48_000;
/** Longest per-item source label, task text and retrieved item the builder accepts. */
export const CONTEXT_SOURCE_MAX_LENGTH = 200;
export const CONTEXT_TASK_TITLE_MAX_LENGTH = 300;
export const CONTEXT_TEXT_MAX_LENGTH = 100_000;
export const CONTEXT_PROMPT_MAX_LENGTH = 20_000;

/**
 * Where a skill's text came from. There is deliberately no default: a new path that stores skills
 * (the pack import, AGO-191) must say which it is, so it can never land as trusted by accident.
 * `owner` skills were written by an owner in the skill library and are trusted instructions;
 * `pack` skills were imported from an agent pack and are untrusted data (CLAUDE.md, agent packs).
 */
export const SKILL_ORIGINS = ["owner", "pack"] as const;
export const skillOriginSchema = z.enum(SKILL_ORIGINS);
export type SkillOrigin = z.infer<typeof skillOriginSchema>;

/** The agent as the run sees it. `role` and `prompt` are owner-written configuration (trusted). */
export const agentProfileSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH),
  role: z.string().max(SKILL_DESCRIPTION_MAX_LENGTH * 4),
  prompt: z.string().max(CONTEXT_PROMPT_MAX_LENGTH).nullable(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** The task packet of a run. Task text is untrusted: it may carry pasted external content. */
export const taskPacketSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string().max(CONTEXT_TASK_TITLE_MAX_LENGTH),
  description: z.string().max(CONTEXT_TEXT_MAX_LENGTH),
});
export type TaskPacket = z.infer<typeof taskPacketSchema>;

/**
 * A skill assigned to the agent, at the version the run reads. `workspaceId` and `agentId` travel with
 * it so the builder can re-check them (AC1) instead of trusting the query that produced the row.
 */
export const assignedSkillSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH),
  version: z.number().int().min(1),
  origin: skillOriginSchema,
  body: z.string().max(SKILL_BODY_MAX_LENGTH),
});
export type AssignedSkill = z.infer<typeof assignedSkillSchema>;

/** One note in the vault map: path and title only, never the note body. Both are untrusted labels. */
export const vaultMapEntrySchema = z.strictObject({
  path: z.string().min(1).max(500),
  title: z.string().max(300),
});
export type VaultMapEntry = z.infer<typeof vaultMapEntrySchema>;

/** Retrieved content (a vault note, a tool result, ...). Always untrusted. `source` is a short label. */
export const retrievedItemSchema = z.strictObject({
  source: z.string().min(1).max(CONTEXT_SOURCE_MAX_LENGTH),
  content: z.string().max(CONTEXT_TEXT_MAX_LENGTH),
});
export type RetrievedItem = z.infer<typeof retrievedItemSchema>;

export const contextBudgetSchema = z.strictObject({
  maxChars: z.number().int().min(1_000).max(2_000_000),
});
export type ContextBudget = z.infer<typeof contextBudgetSchema>;

/** The sections of a context, in priority order (first is kept longest). */
export const CONTEXT_SECTIONS = ["task", "skills", "vault_map", "retrieved"] as const;
export const contextSectionSchema = z.enum(CONTEXT_SECTIONS);
export type ContextSection = z.infer<typeof contextSectionSchema>;

/**
 * One cut made to fit the cap. Counts and source labels only; the cut text itself is never recorded.
 * `dropped`: the item was left out. `truncated`: part of the item was kept.
 */
export const contextCutSchema = z.strictObject({
  section: contextSectionSchema,
  source: z.string().max(CONTEXT_SOURCE_MAX_LENGTH),
  action: z.enum(["dropped", "truncated"]),
  original_chars: z.number().int().nonnegative(),
  kept_chars: z.number().int().nonnegative(),
  items_dropped: z.number().int().nonnegative(),
});
export type ContextCut = z.infer<typeof contextCutSchema>;

export const contextMetadataSchema = z.strictObject({
  run_id: z.uuid(),
  workspace_id: z.uuid(),
  agent_id: z.uuid(),
  task_id: z.uuid().nullable(),
  budget_chars: z.number().int().positive(),
  used_chars: z.number().int().nonnegative(),
  /** The skills that made it into the context, so a run records exactly which text it saw. */
  skills: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      version: z.number().int().min(1),
      origin: skillOriginSchema,
    }),
  ),
  /** Rows the source returned that were not this agent's or this workspace's, and were left out. */
  skills_rejected: z.number().int().nonnegative(),
  vault_entries_included: z.number().int().nonnegative(),
  vault_entries_total: z.number().int().nonnegative(),
  retrieved_included: z.number().int().nonnegative(),
  cuts: z.array(contextCutSchema),
});
export type ContextMetadata = z.infer<typeof contextMetadataSchema>;

export const contextMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string(),
});
export type ContextMessage = z.infer<typeof contextMessageSchema>;

/** What `build(runId)` returns. */
export const builtContextSchema = z.strictObject({
  system: z.string().min(1),
  messages: z.array(contextMessageSchema).min(1),
  metadata: contextMetadataSchema,
});
export type BuiltContext = z.infer<typeof builtContextSchema>;
