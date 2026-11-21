import { z } from "zod";

import { capabilityKeySchema, capabilityTierSchema } from "../capabilities/capability-schemas.js";

import type { CapabilityTier } from "../capabilities/capability-schemas.js";

/**
 * Agent-to-agent handoffs (AGO-81). A handoff is a TASK for another agent, never a message. This file holds the
 * pure schemas and limits; the narrowing and chain rules are in `handoff-rules.ts`. No `node:` imports, so the
 * client can use the subpath `@ago/shared/handoff`.
 *
 * Safety rules baked into the schema:
 * - the request is `.strict()`: a forged `requester`, `approval`, `grants`, `tier` or `workspace_id` field is
 *   rejected, not ignored. The requester and the workspace always come from the stored chain, never from input;
 * - there is no field that can carry an approval, so a handoff can never pre-satisfy one;
 * - the only free text is the task `title` and `description`, which the receiver reads as untrusted data.
 */

/** Longest chain of handoffs: requester, agent A, B, C is depth 3. Mirrors the future `handoff_depth` check. */
export const MAX_HANDOFF_DEPTH = 3;

const MAX_HANDOFF_CAPABILITIES = 64;
const MAX_HANDOFF_SCOPES = 32;

/** A vault path prefix such as `projects/sales/`. Always relative, no `..`, normalised to end with `/`. */
export const dataScopePrefixSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_\-./ ]+$/, "Use a plain relative path prefix.")
  .refine((value) => !value.startsWith("/"), "Use a relative path prefix.")
  .refine((value) => !value.split("/").includes(".."), "Parent paths are not allowed.")
  .transform((value) => (value.endsWith("/") ? value : `${value}/`));

/** What the sender asks for. Narrowing only: anything above what the sender holds is a denied request. */
export const handoffRequestedSchema = z
  .strictObject({
    capabilities: z.array(capabilityKeySchema).max(MAX_HANDOFF_CAPABILITIES).optional(),
    budget_cents: z.number().int().positive().optional(),
    data_scope: z.array(dataScopePrefixSchema).max(MAX_HANDOFF_SCOPES).optional(),
  })
  .optional();

/** The input of the `handoff_task` tool and of `createHandoff`. */
export const handoffRequestSchema = z.strictObject({
  to_agent_id: z.uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(""),
  requested: handoffRequestedSchema,
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

/** One capability grant as the handoff rules see it. */
export interface HandoffGrant {
  readonly capabilityKey: string;
  readonly tier: CapabilityTier;
  readonly mode: "automatic" | "approval";
  readonly isEnabled: boolean;
}

/** What one agent holds at handoff time. `dataScope` is a list of vault path prefixes; empty means none. */
export interface HandoffParty {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly isArchived: boolean;
  readonly grants: readonly HandoffGrant[];
  /** Cents the agent may still spend (its remaining daily budget). */
  readonly budgetCents: number;
  readonly dataScope: readonly string[];
}

/** The permissions a receiver gets for a handoff: the intersection, stored on the handoff task. */
export const narrowedGrantSchema = z.strictObject({
  capabilityKey: capabilityKeySchema,
  tier: capabilityTierSchema,
  mode: z.enum(["automatic", "approval"]),
});
export type NarrowedGrant = z.infer<typeof narrowedGrantSchema>;

export const narrowedPermissionsSchema = z.strictObject({
  capabilities: z.array(narrowedGrantSchema).max(MAX_HANDOFF_CAPABILITIES),
  budgetCents: z.number().int().nonnegative(),
  dataScope: z.array(dataScopePrefixSchema).max(MAX_HANDOFF_SCOPES),
});
export type NarrowedPermissions = z.infer<typeof narrowedPermissionsSchema>;

/**
 * Who a chain of handoffs acts for. `requesterMemberId` is the human member who started the root task. It is
 * copied from the parent task by the worker and can never be set by an agent.
 */
export interface HandoffChain {
  readonly workspaceId: string;
  readonly requesterMemberId: string;
  /** Agent ids from the first sender to the current sender, in order. Its length is the depth of the next hop. */
  readonly path: readonly string[];
}

/** Fixed reason codes: never free text, so a denial carries no task text and no secrets. */
export const HANDOFF_DENIAL_REASONS = [
  "invalid_request",
  "workspace_mismatch",
  "sender_archived",
  "sender_not_found",
  "receiver_not_found",
  "receiver_archived",
  "self_handoff",
  "cycle",
  "depth_exceeded",
  "requester_mismatch",
  "no_requester",
  "widening_capability",
  "widening_budget",
  "widening_scope",
  "no_budget",
] as const;
export type HandoffDenialReason = (typeof HANDOFF_DENIAL_REASONS)[number];
