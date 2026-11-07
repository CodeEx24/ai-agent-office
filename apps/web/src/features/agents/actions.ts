"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AGENT_TEMPLATE_IDS, createAgentSchema } from "@ago/shared";
import { z } from "zod";

import { AgentCredentialRejectedError, requireHumanRequest } from "../../lib/auth/human-only";
import { formDataToRecord, parseInput } from "../../lib/validation/parse-input";
import { agentCreator } from "./agent-library";
import {
  agentFormRecord,
  createAgentWith,
  GENERIC_ERROR,
  invalidInputState,
  type AgentWizardState,
} from "./create-agent";
import { createAgentFromTemplateWith } from "./create-from-template";

const createFromTemplateSchema = z.strictObject({
  workspaceId: z.uuid(),
  templateId: z.enum(AGENT_TEMPLATE_IDS),
});

const AGENT_CREDENTIAL_ERROR = "Agents cannot create agents. This action is for people only.";

/** AGO-148: creating an agent is a human decision; an agent credential can never call these actions. */
async function rejectAgentCredential(): Promise<AgentWizardState | null> {
  try {
    await requireHumanRequest();
    return null;
  } catch (error) {
    if (error instanceof AgentCredentialRejectedError) return { error: AGENT_CREDENTIAL_ERROR };
    throw error;
  }
}

/**
 * Creates an agent from the wizard (AGO-141). Owners only; the agent, its skills and its capability grants
 * are created in one transaction and the agent is always Strict. Error mapping lives in `create-agent.ts` so
 * it can be unit tested; only this async function is exposed as an endpoint.
 */
export async function createAgentAction(
  _prev: AgentWizardState,
  formData: FormData,
): Promise<AgentWizardState> {
  const rejected = await rejectAgentCredential();
  if (rejected) return rejected;

  const parsed = parseInput(createAgentSchema, agentFormRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await createAgentWith(agentCreator, parsed.data);
  if (!result.createdId) return result;
  revalidatePath("/app/agents");
  redirect("/app/agents");
}

/**
 * One-click "Create from template" (AGO-136). Owners only, enforced by the same `agentCreator` the wizard uses
 * (`requireWorkspaceRole(..., "owner")` and the owner-only RLS policy), so members and viewers are refused even
 * if they post this form by hand. The template id is validated against the fixed list; the agent starts in
 * Strict mode. The template logic lives in `create-from-template.ts` so it can be tested without an endpoint.
 */
export async function createAgentFromTemplateAction(
  _prev: AgentWizardState,
  formData: FormData,
): Promise<AgentWizardState> {
  const rejected = await rejectAgentCredential();
  if (rejected) return rejected;

  const parsed = parseInput(
    createFromTemplateSchema,
    formDataToRecord(formData),
    "Choose a template.",
  );
  if (!parsed.success) return { error: parsed.message };

  const result = await createAgentFromTemplateWith(
    agentCreator,
    parsed.data.workspaceId,
    parsed.data.templateId,
  );
  if (!result.createdId) return result;
  revalidatePath("/app/agents");
  redirect("/app/agents");
}
