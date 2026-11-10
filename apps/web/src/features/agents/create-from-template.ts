import { agentInputFromTemplate, findAgentTemplate } from "@ago/shared";

import type { AgentCreator } from "./agent-library";
import { createAgentWith, type AgentWizardState } from "./create-agent";

export const UNKNOWN_TEMPLATE_ERROR = "That template does not exist.";
export const NAME_TAKEN_ERROR =
  "Could not find a free name for this agent. Rename an existing one.";

/** How many names to try ("Researcher", "Researcher 2", ...) before giving up. */
const MAX_NAME_ATTEMPTS = 20;

/**
 * One-click "Create from template" (AGO-136). There is no second creation path: the template is turned into
 * the wizard's own input (`agentInputFromTemplate`, validated with `createAgentSchema`) and goes through the
 * same `createAgentWith` and `create_agent` call as the wizard, so the owner-only check, the catalog and tier
 * checks, row-level security and Strict mode all apply unchanged. Only the name is picked here: a name must be
 * unique in the workspace, so a taken name gets a number ("Researcher 2").
 */
export async function createAgentFromTemplateWith(
  creator: AgentCreator,
  workspaceId: string,
  templateId: string,
): Promise<AgentWizardState & { createdId?: string }> {
  const template = findAgentTemplate(templateId);
  if (!template) return { error: UNKNOWN_TEMPLATE_ERROR };

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? template.name : `${template.name} ${String(attempt)}`;
    const result = await createAgentWith(
      creator,
      agentInputFromTemplate(template, workspaceId, name),
    );
    // A taken name is reported against the name field; anything else is final (created or refused).
    if (!result.fieldErrors?.name) return result;
  }
  return { error: NAME_TAKEN_ERROR };
}
