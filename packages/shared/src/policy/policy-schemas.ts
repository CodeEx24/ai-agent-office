import { z } from "zod";

/**
 * Policy layers, least to most specific. Mirrors `policies_level_check` in the database (AGO-96).
 * The policy engine (AGO-34) decides how layers combine; this module only describes what is stored.
 */
export const POLICY_LEVELS = ["baseline", "department", "team", "agent"] as const;

export const policyLevelSchema = z.enum(POLICY_LEVELS);
export type PolicyLevel = z.infer<typeof policyLevelSchema>;

/** What a rule does when its `action` matches. Humans stay in the loop: `require_approval` is a first-class effect. */
export const POLICY_EFFECTS = ["allow", "require_approval", "deny"] as const;
export const policyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

/** Upper bound on rules in one policy row: a policy is read on every tool call, so keep it small. */
export const MAX_POLICY_RULES = 200;

/**
 * The `policies.rule` payload. Strict on purpose: unknown keys are rejected, never stored.
 * `action` is an opaque capability or tool name here; matching semantics belong to the engine (AGO-34).
 */
export const policyRuleSchema = z.strictObject({
  version: z.literal(1),
  rules: z
    .array(
      z.strictObject({
        action: z.string().min(1).max(200),
        effect: policyEffectSchema,
        note: z.string().max(500).optional(),
      }),
    )
    .max(MAX_POLICY_RULES),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

/**
 * Input for writing a policy (owners only, enforced by RLS). Mirrors `policies_scope_matches_level`:
 * a baseline policy has no scope; every other level needs the id of its department, team or agent.
 */
export const createPolicySchema = z
  .strictObject({
    level: policyLevelSchema,
    scopeId: z.uuid().nullable(),
    rule: policyRuleSchema,
  })
  .refine(
    (policy) => (policy.level === "baseline" ? policy.scopeId === null : policy.scopeId !== null),
    {
      message: "A baseline policy has no scope; department, team and agent policies need a scopeId",
      path: ["scopeId"],
    },
  );
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
