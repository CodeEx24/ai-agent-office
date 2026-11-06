/**
 * Skill size limits (AGO-128). Kept free of runtime imports (no zod) so client components can import
 * them without pulling zod, whose JIT feature detection needs `unsafe-eval`, into the browser bundle.
 */

/** Longest skill text. Mirrors the `skills_body_length_check` and `skill_versions.body` checks. */
export const SKILL_BODY_MAX_LENGTH = 20_000;
export const SKILL_NAME_MAX_LENGTH = 120;
export const SKILL_DESCRIPTION_MAX_LENGTH = 500;
