import { z } from "zod";

import {
  capabilityKeySchema,
  isAllowedDefaultMode,
  type Capability,
  type CapabilityDefaultMode,
} from "../capabilities/capability-schemas.js";
import {
  AGENT_FIELDS,
  AGENT_MESSAGES,
  AGENT_MODEL_IDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
  normalizeText,
  parseDailyBudget,
  type AgentField,
} from "./agent-limits.js";

export * from "./agent-limits.js";

/**
 * Agent creation wizard (AGO-141). One schema for the server action; the client uses the zod-free checks in
 * `agent-limits.ts` with the same messages. A new agent is always created in Strict mode and the input has no
 * field that could say otherwise (strict objects reject unknown keys).
 */

const text = (max: number, required: string, tooLong: string) =>
  z.string(required).transform(normalizeText).pipe(z.string().min(1, required).max(max, tooLong));

export const agentNameSchema = text(
  AGENT_NAME_MAX_LENGTH,
  AGENT_MESSAGES.nameRequired,
  AGENT_MESSAGES.nameTooLong,
);
export const agentRoleSchema = text(
  AGENT_ROLE_MAX_LENGTH,
  AGENT_MESSAGES.roleRequired,
  AGENT_MESSAGES.roleTooLong,
);
export const agentPromptSchema = text(
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_MESSAGES.promptRequired,
  AGENT_MESSAGES.promptTooLong,
);
export const agentModelSchema = z.enum(AGENT_MODEL_IDS, {
  error: (issue) =>
    issue.input === undefined || issue.input === ""
      ? AGENT_MESSAGES.modelRequired
      : AGENT_MESSAGES.modelUnknown,
});

/** Dollars as typed ("5.00") to whole cents. */
export const agentDailyBudgetSchema = z
  .string(AGENT_MESSAGES.budgetRequired)
  .transform((value, ctx) => {
    const result = parseDailyBudget(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.cents;
  });

/** A capability the owner ticked, and how it should run. The tier is never sent: the server reads it. */
export const agentCapabilityChoiceSchema = z.strictObject({
  key: capabilityKeySchema,
  mode: z.enum(["automatic", "approval"]),
});
export type AgentCapabilityChoice = z.infer<typeof agentCapabilityChoiceSchema>;

export const MAX_AGENT_SKILLS = 50;
export const MAX_AGENT_CAPABILITIES = 50;

/** Input of the create-agent action, after the form's JSON fields have been parsed. */
export const createAgentSchema = z.strictObject({
  workspaceId: z.uuid(),
  name: agentNameSchema,
  role: agentRoleSchema,
  model: agentModelSchema,
  prompt: agentPromptSchema,
  skillIds: z.array(z.uuid()).max(MAX_AGENT_SKILLS, "Skills: choose at most 50."),
  capabilities: z
    .array(agentCapabilityChoiceSchema)
    .max(MAX_AGENT_CAPABILITIES, "Capabilities: choose at most 50."),
  dailyBudget: agentDailyBudgetSchema,
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

/** One capability grant after it was checked against the catalog. */
export interface AgentCapabilityGrant {
  key: string;
  mode: CapabilityDefaultMode;
}

export type CapabilityResolution =
  { ok: true; grants: AgentCapabilityGrant[] } | { ok: false; field: AgentField; message: string };

/**
 * Checks the owner's capability choices against the workspace catalog (the only source of tiers).
 * Unknown or disabled keys are refused, a repeated key is collapsed, and a Tier 3 or 4 capability may never
 * be automatic, whatever the request said: that is the human-in-the-loop rule, and the database repeats it.
 */
export function resolveCapabilityGrants(
  choices: readonly AgentCapabilityChoice[],
  catalog: readonly Pick<Capability, "key" | "tier" | "enabled">[],
): CapabilityResolution {
  const byKey = new Map(catalog.map((capability) => [capability.key, capability]));
  const grants = new Map<string, AgentCapabilityGrant>();
  for (const choice of choices) {
    const capability = byKey.get(choice.key);
    if (!capability?.enabled) {
      return {
        ok: false,
        field: "capabilities",
        message: `Capabilities: ${choice.key} is not available in this workspace.`,
      };
    }
    if (!isAllowedDefaultMode(capability.tier, choice.mode)) {
      return { ok: false, field: "capabilities", message: AGENT_MESSAGES.capabilityApproval };
    }
    grants.set(choice.key, { key: choice.key, mode: choice.mode });
  }
  return { ok: true, grants: [...grants.values()] };
}

const FIELD_NAMES: ReadonlySet<string> = new Set(AGENT_FIELDS);

/** The first message per wizard field from a failed parse (the field is the first path segment). */
export function fieldErrorsFromIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Partial<Record<AgentField | "form", string>> {
  const errors: Partial<Record<AgentField | "form", string>> = {};
  for (const issue of issues) {
    const head = issue.path[0];
    const key: AgentField | "form" =
      typeof head === "string" && FIELD_NAMES.has(head) ? (head as AgentField) : "form";
    errors[key] ??= issue.message;
  }
  return errors;
}
