import { z } from "zod";

import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
} from "../agents/agent-limits.js";
import { capabilityKeySchema, capabilityScopeSchema } from "../capabilities/capability-schemas.js";
import { secretRefSchema } from "../credentials/broker-schemas.js";
import { POLICY_AGENT_MODES } from "../policy/policy-engine.js";
import { SECRET_VALUE_PATTERNS } from "../redaction/redact.js";
import { SKILL_BODY_MAX_LENGTH, SKILL_NAME_MAX_LENGTH } from "../skills/skill-limits.js";

/**
 * Agent pack, format version 1 (AGO-191, epic EP-19). One JSON file that moves a team of agents and their
 * skills between computers. This file is the single definition: export (AGO-192), dry-run import (AGO-193),
 * the API, the CLI and the UI all parse with it, and `schemas/agent-pack.v1.schema.json` is generated from it.
 *
 * What a pack never holds (CLAUDE.md, agent packs): secrets, database ids, run history, approval history,
 * policies, identities, credentials. Every object is strict, so a field the format does not name (an `id`,
 * `runs`, `approvals`, `apiKey`, ...) is rejected with its path instead of being carried along. The only
 * way a pack can point at a credential is a named reference, `secret:<name>`, never a value. Importers
 * treat all pack text (prompts, skills, notes) as untrusted data.
 */

/** The version this code writes. Older versions are upgraded by `migrateAgentPack`. */
export const PACK_VERSION = 1;

export const MAX_PACK_AGENTS = 100;
export const MAX_PACK_SKILLS = 500;
export const MAX_PACK_NOTES = 500;
export const MAX_PACK_AGENT_SKILLS = 50;
export const MAX_PACK_AGENT_CAPABILITIES = 50;
export const MAX_PACK_AGENT_SECRET_REFS = 50;
export const PACK_NOTE_TITLE_MAX_LENGTH = 200;
export const PACK_NOTE_BODY_MAX_LENGTH = 20_000;
export const PACK_METADATA_NAME_MAX_LENGTH = 120;
export const PACK_APP_VERSION_MAX_LENGTH = 64;
export const PACK_MODEL_MAX_LENGTH = 100;
export const PACK_DEPARTMENT_MAX_LENGTH = 120;
/** Sanity bound only: the workspace cap is applied by the importer, which ignores and reports a higher budget. */
export const PACK_DAILY_BUDGET_MAX_CENTS = 100_000_000;

/** How hard an agent thinks. Lowest to highest. */
export const PACK_THINKING_EFFORTS = ["low", "medium", "high"] as const;
export const packThinkingEffortSchema = z.enum(PACK_THINKING_EFFORTS);
export type PackThinkingEffort = z.infer<typeof packThinkingEffortSchema>;

/** Autonomy as exported. Import ignores it: every imported agent lands in Strict mode. */
export const packAutonomyModeSchema = z.enum(POLICY_AGENT_MODES);

/** Text that must contain something other than whitespace, within a length bound. */
const nonBlankText = (max: number) =>
  z
    .string()
    .max(max, `Use at most ${String(max)} characters.`)
    .refine((value) => value.trim().length > 0, { message: "Must not be empty." });

const boundedText = (max: number) => z.string().max(max, `Use at most ${String(max)} characters.`);

export const packCapabilitySchema = z.strictObject({
  /** The catalog key, such as `vault.read`. The importer looks up the tier; the pack never carries one. */
  name: capabilityKeySchema,
  scope: capabilityScopeSchema,
});
export type PackCapability = z.infer<typeof packCapabilitySchema>;

export const packSkillSchema = z.strictObject({
  name: nonBlankText(SKILL_NAME_MAX_LENGTH),
  /** The skill library version this text was exported from. */
  version: z.number().int().min(1),
  /** Markdown. Untrusted text: never instructions to the platform. */
  body: boundedText(SKILL_BODY_MAX_LENGTH),
});
export type PackSkill = z.infer<typeof packSkillSchema>;

export const packAgentSchema = z.strictObject({
  name: nonBlankText(AGENT_NAME_MAX_LENGTH),
  role: nonBlankText(AGENT_ROLE_MAX_LENGTH),
  /** A model id as text. The importer checks it against the allowlist and reports an unknown model. */
  model: nonBlankText(PACK_MODEL_MAX_LENGTH),
  thinkingEffort: packThinkingEffortSchema,
  prompt: nonBlankText(AGENT_PROMPT_MAX_LENGTH),
  /** Names of skills in `skills[]`. */
  skills: z.array(nonBlankText(SKILL_NAME_MAX_LENGTH)).max(MAX_PACK_AGENT_SKILLS),
  capabilities: z.array(packCapabilitySchema).max(MAX_PACK_AGENT_CAPABILITIES),
  /** Whole US cents per day. */
  dailyBudgetCents: z.number().int().min(1).max(PACK_DAILY_BUDGET_MAX_CENTS),
  autonomyMode: packAutonomyModeSchema,
  /** A department by name, never by id. */
  department: nonBlankText(PACK_DEPARTMENT_MAX_LENGTH).optional(),
  /** Broker secrets the agent expects, by reference only (`secret:crm_api_key`). Never a value. */
  secretRefs: z.array(secretRefSchema).max(MAX_PACK_AGENT_SECRET_REFS).optional(),
});
export type PackAgent = z.infer<typeof packAgentSchema>;

export const packNoteSchema = z.strictObject({
  title: nonBlankText(PACK_NOTE_TITLE_MAX_LENGTH),
  /** Markdown. Untrusted text. */
  body: boundedText(PACK_NOTE_BODY_MAX_LENGTH),
});
export type PackNote = z.infer<typeof packNoteSchema>;

export const packMetadataSchema = z.strictObject({
  name: nonBlankText(PACK_METADATA_NAME_MAX_LENGTH),
  exportedAt: z.iso.datetime({ offset: true }),
  /** The version of the app that wrote the pack. */
  appVersion: nonBlankText(PACK_APP_VERSION_MAX_LENGTH),
});
export type PackMetadata = z.infer<typeof packMetadataSchema>;

/**
 * A JWT or `scheme://user:password@host`: value shapes `SECRET_VALUE_PATTERNS` does not cover.
 * The URL scheme is bounded ({0,30}): an unbounded run made the scan quadratic on text like "a.a.a.".
 * The JWT starts after a lookbehind, not a word boundary: `` matched after every `-` or `_`, so
 * text like "eyJ-eyJ-" restarted the match at every position and was quadratic. The URL user part
 * may be empty (`redis://:password@host`).
 */
const EXTRA_SECRET_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}/, "token"],
  [/\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@:]*:[^\s/@]+@/i, "password in a URL"],
];

/** The longest string any pack field accepts. Longer strings fail their own length check. */
const MAX_SCANNED_TEXT_LENGTH = Math.max(
  AGENT_PROMPT_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  PACK_NOTE_BODY_MAX_LENGTH,
);

/** The label of the first secret-shaped value in a string, or null. Shapes only, so prose about tokens is fine. */
export function findSecretShape(text: string): string | null {
  for (const [pattern, label] of [...SECRET_VALUE_PATTERNS, ...EXTRA_SECRET_SHAPES]) {
    if (pattern.test(text)) return label;
  }
  return null;
}

type PathSegment = string | number;

function* walkStrings(
  value: unknown,
  path: PathSegment[] = [],
): Generator<{ path: PathSegment[]; text: string }> {
  if (typeof value === "string") {
    yield { path, text: value };
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* walkStrings(item, [...path, index]);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) yield* walkStrings(item, [...path, key]);
  }
}

/** Every object key in the value, with the path of the object that holds it (the key itself is not in the path). */
function* walkKeys(
  value: unknown,
  path: PathSegment[] = [],
): Generator<{ path: PathSegment[]; key: string }> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* walkKeys(item, [...path, index]);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield { path, key };
      yield* walkKeys(item, [...path, key]);
    }
  }
}

/** A name for an issue message. A secret-shaped name is never echoed: pack text is untrusted and issues get logged. */
function quoteName(name: string): string {
  return findSecretShape(name) ? "(a value that looks like a secret)" : `"${name}"`;
}

function addIssue(ctx: z.RefinementCtx, path: PathSegment[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

interface PackBody {
  agents: PackAgent[];
  skills: PackSkill[];
}

/** Cross-field rules: unique names, skills that exist, and no secret-shaped value anywhere. */
function refinePack(pack: PackBody, ctx: z.RefinementCtx): void {
  const skillNames = new Set<string>();
  for (const [index, skill] of pack.skills.entries()) {
    if (skillNames.has(skill.name)) {
      addIssue(
        ctx,
        ["skills", index, "name"],
        `Skill name ${quoteName(skill.name)} is used twice.`,
      );
    }
    skillNames.add(skill.name);
  }

  const agentNames = new Set<string>();
  for (const [index, agent] of pack.agents.entries()) {
    if (agentNames.has(agent.name)) {
      addIssue(
        ctx,
        ["agents", index, "name"],
        `Agent name ${quoteName(agent.name)} is used twice.`,
      );
    }
    agentNames.add(agent.name);

    for (const [skillIndex, skillName] of agent.skills.entries()) {
      if (!skillNames.has(skillName)) {
        addIssue(
          ctx,
          ["agents", index, "skills", skillIndex],
          `Skill ${quoteName(skillName)} is not in this pack's skills.`,
        );
      } else if (agent.skills.indexOf(skillName) !== skillIndex) {
        addIssue(
          ctx,
          ["agents", index, "skills", skillIndex],
          `Skill ${quoteName(skillName)} is listed twice.`,
        );
      }
    }

    const seenCapabilities = new Set<string>();
    for (const [capIndex, capability] of agent.capabilities.entries()) {
      if (seenCapabilities.has(capability.name)) {
        addIssue(
          ctx,
          ["agents", index, "capabilities", capIndex, "name"],
          `Capability ${quoteName(capability.name)} is listed twice.`,
        );
      }
      seenCapabilities.add(capability.name);
    }

    const seenRefs = new Set<string>();
    for (const [refIndex, ref] of (agent.secretRefs ?? []).entries()) {
      if (seenRefs.has(ref)) {
        addIssue(
          ctx,
          ["agents", index, "secretRefs", refIndex],
          `Reference ${quoteName(ref)} is listed twice.`,
        );
      }
      seenRefs.add(ref);
    }
  }

  // Field names are untrusted text too: report where, never the name.
  for (const { path, key } of walkKeys(pack)) {
    if (key.length > MAX_SCANNED_TEXT_LENGTH) continue;
    const label = findSecretShape(key);
    if (label) {
      addIssue(ctx, path, `A field name looks like a ${label}. A pack never holds secret values.`);
    }
  }

  for (const { path, text } of walkStrings(pack)) {
    // A string past the largest field limit already has a length issue, so the pack is rejected
    // anyway: do not spend scan time on it.
    if (text.length > MAX_SCANNED_TEXT_LENGTH) continue;
    const label = findSecretShape(text);
    if (label) {
      addIssue(
        ctx,
        path,
        `Looks like a ${label}. A pack never holds secret values; use a secret:<name> reference.`,
      );
    }
  }
}

export const PACK_CHECKSUM_ALGORITHM = "sha256";

/**
 * Integrity checksum of the pack content (AGO-192). Optional so every v1 pack written before export existed
 * stays valid. What is hashed: the UTF-8 bytes of the canonical JSON (object keys sorted, no whitespace, no
 * trailing newline) of this same pack with the `checksum` field removed. `exportedAt` is part of those bytes.
 * It detects accidental change and tampering with a pack that kept its checksum; it is not a signature (AGO-199).
 */
export const packChecksumSchema = z.strictObject({
  algorithm: z.literal(PACK_CHECKSUM_ALGORITHM),
  /** Lowercase hex SHA-256 digest. */
  value: z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hex digest."),
});
export type PackChecksum = z.infer<typeof packChecksumSchema>;

export const agentPackSchema = z
  .strictObject({
    /** Lets editors find the JSON Schema. Optional and ignored. */
    $schema: z.string().max(300).optional(),
    /** Required. Older versions are upgraded by `migrateAgentPack` before this schema is applied. */
    packVersion: z.literal(PACK_VERSION),
    /** Optional integrity checksum written by export; see `packChecksumSchema` for exactly what it covers. */
    checksum: packChecksumSchema.optional(),
    metadata: packMetadataSchema,
    agents: z.array(packAgentSchema).max(MAX_PACK_AGENTS),
    skills: z.array(packSkillSchema).max(MAX_PACK_SKILLS),
    notes: z.array(packNoteSchema).max(MAX_PACK_NOTES).optional(),
  })
  .superRefine(refinePack);
export type AgentPack = z.infer<typeof agentPackSchema>;
