import { z } from "zod";

import { capabilityKeySchema } from "../capabilities/capability-schemas.js";
import {
  AGENT_DAILY_BUDGET_MAX_CENTS,
  AGENT_MODEL_IDS,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
} from "./agent-limits.js";
import { createAgentSchema, type CreateAgentInput } from "./agent-schemas.js";
import { AGENT_TEMPLATE_IDS, type AgentTemplate } from "./agent-templates.js";

export * from "./agent-templates.js";

/** The allowlist minus Haiku: the models a template may suggest are Opus, Sonnet or Fable. */
const SUGGESTABLE_MODEL_IDS = AGENT_MODEL_IDS.filter((id) => !id.includes("haiku")) as [
  string,
  ...string[],
];

/**
 * Shape of a role template (AGO-136). There is no `mode`, `tier` or `status` field, so a template cannot ask
 * for anything but Strict mode and cannot carry a tier.
 */
export const agentTemplateSchema = z.strictObject({
  id: z.enum(AGENT_TEMPLATE_IDS),
  name: z.string().min(1).max(100),
  summary: z.string().min(1).max(200),
  role: z.string().min(1).max(AGENT_ROLE_MAX_LENGTH),
  model: z.enum(SUGGESTABLE_MODEL_IDS),
  prompt: z.string().min(1).max(AGENT_PROMPT_MAX_LENGTH),
  dailyBudgetCents: z.number().int().min(1).max(AGENT_DAILY_BUDGET_MAX_CENTS),
  capabilities: z.array(
    z.strictObject({ key: capabilityKeySchema, mode: z.enum(["automatic", "approval"]) }),
  ),
});

/**
 * The create-agent input for a template, validated with the same `createAgentSchema` the wizard uses, so a
 * template can never produce an agent the wizard would refuse. `name` is passed in because it must be unique
 * in the workspace. The agent still starts in Strict mode: the input has no field for anything else.
 */
export function agentInputFromTemplate(
  template: AgentTemplate,
  workspaceId: string,
  name: string,
): CreateAgentInput {
  return createAgentSchema.parse({
    workspaceId,
    name,
    role: template.role,
    model: template.model,
    prompt: template.prompt,
    dailyBudget: (template.dailyBudgetCents / 100).toFixed(2),
    skillIds: [],
    capabilities: template.capabilities.map(({ key, mode }) => ({ key, mode })),
  });
}
