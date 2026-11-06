import { z } from "zod";

/**
 * Skill library (AGO-128). A skill is Markdown know-how an owner writes and assigns to agents. It is
 * untrusted data, never instructions to the platform, and it never grants a permission (see capabilities).
 */

/** Longest skill text. Mirrors the `skills_body_length_check` and `skill_versions.body` checks. */
export const SKILL_BODY_MAX_LENGTH = 20_000;
export const SKILL_NAME_MAX_LENGTH = 120;
export const SKILL_DESCRIPTION_MAX_LENGTH = 500;

export const skillNameSchema = z
  .string()
  .trim()
  .min(1, "Give the skill a name.")
  .max(
    SKILL_NAME_MAX_LENGTH,
    `Use at most ${String(SKILL_NAME_MAX_LENGTH)} characters for the name.`,
  );

export const skillDescriptionSchema = z
  .string()
  .trim()
  .max(
    SKILL_DESCRIPTION_MAX_LENGTH,
    `Use at most ${String(SKILL_DESCRIPTION_MAX_LENGTH)} characters for the description.`,
  );

/**
 * Skill text. Browsers submit textarea line breaks as CRLF, so line endings are normalised to LF first;
 * the size limit then counts the text that is stored.
 */
export const skillBodySchema = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, "\n"))
  .pipe(
    z
      .string()
      .max(
        SKILL_BODY_MAX_LENGTH,
        `Skill text can be at most ${SKILL_BODY_MAX_LENGTH.toLocaleString("en-US")} characters.`,
      ),
  );

/** Input of the create-skill action. */
export const createSkillSchema = z.strictObject({
  workspaceId: z.uuid(),
  name: skillNameSchema,
  description: skillDescriptionSchema,
  body: skillBodySchema,
});
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

/**
 * Input of the save-skill action. `expectedVersion` is the version the editor loaded: if someone saved
 * in between, the save is refused instead of silently overwriting their text.
 */
export const saveSkillSchema = z.strictObject({
  workspaceId: z.uuid(),
  skillId: z.uuid(),
  expectedVersion: z.coerce.number().int().min(1),
  description: skillDescriptionSchema,
  body: skillBodySchema,
});
export type SaveSkillInput = z.infer<typeof saveSkillSchema>;

/** Input of the assign and unassign actions. */
export const assignSkillSchema = z.strictObject({
  workspaceId: z.uuid(),
  skillId: z.uuid(),
  agentId: z.uuid(),
});
export type AssignSkillInput = z.infer<typeof assignSkillSchema>;

/** One skill as the data layer returns it: the current row, mirroring its latest version. */
export const skillSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  description: z.string(),
  body: skillBodySchema,
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof skillSchema>;

/** One immutable version of a skill's text. `createdBy` is a member id, or null for seed data. */
export const skillVersionSchema = z.strictObject({
  id: z.uuid(),
  skillId: z.uuid(),
  version: z.number().int().min(1),
  body: skillBodySchema,
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

/** An agent a skill is assigned to. The assignment follows the skill's latest version. */
export const skillAssignmentSchema = z.strictObject({
  agentId: z.uuid(),
  agentName: z.string(),
});
export type SkillAssignment = z.infer<typeof skillAssignmentSchema>;
