import { z } from "zod";

/**
 * Risk tiers, 0 (read only) to 4 (irreversible or costly). Mirrors `capabilities.tier` (AGO-125).
 * Tier 3 and 4 never run on their own: an agent can never act on them without a human decision.
 */
export const CAPABILITY_TIERS = [0, 1, 2, 3, 4] as const;
export const capabilityTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type CapabilityTier = z.infer<typeof capabilityTierSchema>;

/** Lowest tier that can never be automatic. Mirrors `capabilities_high_tier_never_automatic`. */
export const MIN_NEVER_AUTOMATIC_TIER = 3;

/** Where a capability acts. Mirrors `capabilities_scope_check`. */
export const CAPABILITY_SCOPES = ["workspace", "agent", "external", "sandbox"] as const;
export const capabilityScopeSchema = z.enum(CAPABILITY_SCOPES);
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

/** Default handling. `approval` always asks a human; `automatic` is allowed below tier 3 only. */
export const CAPABILITY_DEFAULT_MODES = ["automatic", "approval"] as const;
export const capabilityDefaultModeSchema = z.enum(CAPABILITY_DEFAULT_MODES);
export type CapabilityDefaultMode = z.infer<typeof capabilityDefaultModeSchema>;

/** Lowercase dotted key such as `vault.read`. Mirrors the `capabilities.key` check. */
export const capabilityKeySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Use a lowercase dotted key such as vault.read.");

/** True when a tier and default mode may be stored together. Tier 3 and 4 cannot be automatic. */
export function isAllowedDefaultMode(tier: CapabilityTier, mode: CapabilityDefaultMode): boolean {
  return tier < MIN_NEVER_AUTOMATIC_TIER || mode === "approval";
}

/** The fields the migration seeds for each starter capability. */
const capabilityDefinitionShape = {
  key: capabilityKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  tier: capabilityTierSchema,
  scope: capabilityScopeSchema,
  defaultMode: capabilityDefaultModeSchema,
};

function refineDefaultMode(
  value: { tier: CapabilityTier; defaultMode: CapabilityDefaultMode },
  ctx: z.RefinementCtx,
): void {
  if (!isAllowedDefaultMode(value.tier, value.defaultMode)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultMode"],
      message: "Tier 3 and 4 capabilities cannot be automatic.",
    });
  }
}

export const capabilityDefinitionSchema = z
  .strictObject(capabilityDefinitionShape)
  .superRefine(refineDefaultMode);
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

/** One catalog row as the read API returns it. */
export const capabilitySchema = z
  .strictObject({
    id: z.uuid(),
    workspaceId: z.uuid(),
    ...capabilityDefinitionShape,
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine(refineDefaultMode);
export type Capability = z.infer<typeof capabilitySchema>;

/** Query for the read API: which workspace's catalog to return. */
export const listCapabilitiesQuerySchema = z.strictObject({ workspace_id: z.uuid() });
export type ListCapabilitiesQuery = z.infer<typeof listCapabilitiesQuerySchema>;

/** Response body of `GET /api/capabilities`. */
export const listCapabilitiesResponseSchema = z.strictObject({
  capabilities: z.array(capabilitySchema),
});
export type ListCapabilitiesResponse = z.infer<typeof listCapabilitiesResponseSchema>;
