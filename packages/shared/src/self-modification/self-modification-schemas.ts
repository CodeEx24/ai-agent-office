import { z } from "zod";

/**
 * Self-modification protection (AGO-154). Only people change an agent's prompt, skills, policies and boot
 * files. When an agent tries, the attempt becomes a proposal that a person reviews; nothing is applied.
 * This file holds the shapes shared by the worker guard and the web app. Proposal text is untrusted data.
 */

export const PROTECTED_TARGET_KINDS = ["agent_prompt", "skill", "policy", "boot_file"] as const;
export type ProtectedTargetKind = (typeof PROTECTED_TARGET_KINDS)[number];
export const protectedTargetKindSchema = z.enum(PROTECTED_TARGET_KINDS);

export const PROPOSAL_CONTENT_MAX_LENGTH = 100_000;
export const PROPOSAL_TARGET_REF_MAX_LENGTH = 500;

/**
 * A boot file is read by an agent before it starts work, so changing one changes the agent's behaviour like
 * a prompt does. Matching is by path only (the vault, AGO-121, does not exist yet). It is conservative: any
 * path segment named `_boot` or `.claude`, any file named AGENTS.md, CLAUDE.md or BOOT.md, and any path that
 * tries to climb out with `..`, counts. Case and slash style do not matter.
 */
const BOOT_DIRECTORY_SEGMENTS: ReadonlySet<string> = new Set(["_boot", ".claude"]);
const BOOT_FILE_NAMES: ReadonlySet<string> = new Set(["agents.md", "claude.md", "boot.md"]);

export function classifyBootPath(path: string): boolean {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return false;
  if (segments.includes("..")) return true;
  if (segments.slice(0, -1).some((segment) => BOOT_DIRECTORY_SEGMENTS.has(segment))) return true;
  const last = segments[segments.length - 1] ?? "";
  return BOOT_DIRECTORY_SEGMENTS.has(last) || BOOT_FILE_NAMES.has(last);
}

/**
 * An agent's attempt to change protected configuration. `targetRef` is the id of the agent, skill or policy,
 * or the path of the boot file. There is deliberately no "human" actor: people change configuration through
 * the web app, never through this path.
 */
export const agentConfigChangeSchema = z
  .strictObject({
    workspaceId: z.uuid(),
    agentId: z.uuid(),
    kind: protectedTargetKindSchema,
    targetRef: z.string().trim().min(1).max(PROPOSAL_TARGET_REF_MAX_LENGTH),
    proposedContent: z.string().max(PROPOSAL_CONTENT_MAX_LENGTH),
  })
  .refine((change) => change.kind !== "boot_file" || classifyBootPath(change.targetRef), {
    message: "not a boot file path",
    path: ["targetRef"],
  });
export type AgentConfigChange = z.infer<typeof agentConfigChangeSchema>;

export const configProposalSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  kind: protectedTargetKindSchema,
  targetRef: z.string().min(1).max(PROPOSAL_TARGET_REF_MAX_LENGTH),
  proposedContent: z.string().max(PROPOSAL_CONTENT_MAX_LENGTH),
  status: z.literal("pending"),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConfigProposal = z.infer<typeof configProposalSchema>;

/** What the guard tells the caller. Never carries the proposed content. */
export const CONFIG_GUARD_DENIAL_REASONS = ["invalid_change", "proposal_store_failed"] as const;
export type ConfigGuardDenialReason = (typeof CONFIG_GUARD_DENIAL_REASONS)[number];
export type ConfigGuardResult =
  | { readonly outcome: "proposed"; readonly proposalId: string }
  | { readonly outcome: "denied"; readonly reason: ConfigGuardDenialReason };
