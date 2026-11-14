"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AGENT_TEMPLATE_IDS,
  agentRefSchema,
  createAgentSchema,
  duplicateAgentSchema,
  updateAgentSchema,
} from "@ago/shared";
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
import { agentEditor } from "./agent-editor";
import {
  AGENT_CREDENTIAL_EDIT_ERROR,
  archiveAgentWith,
  duplicateAgentWith,
  unarchiveAgentWith,
  updateAgentWith,
  type AgentEditState,
} from "./edit-agent";

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

/** AGO-89: changing an agent is a human decision; an agent credential can never call these actions. */
async function rejectAgentCredentialForEdit(): Promise<AgentEditState | null> {
  try {
    await requireHumanRequest();
    return null;
  } catch (error) {
    if (error instanceof AgentCredentialRejectedError) {
      return { error: AGENT_CREDENTIAL_EDIT_ERROR };
    }
    throw error;
  }
}

function revalidateAgents(agentId: string): void {
  revalidatePath("/app/agents");
  revalidatePath(`/app/agents/${agentId}`);
}

/**
 * Saves the edit form (AGO-89). Owners only, enforced again by `agentEditor` and the `update_agent` function.
 * The version the form was loaded with is sent back; an edit made on an older version is refused, not merged.
 * Every save writes a version row (the audit trail) in the same transaction.
 */
export async function updateAgentAction(
  _prev: AgentEditState,
  formData: FormData,
): Promise<AgentEditState> {
  const rejected = await rejectAgentCredentialForEdit();
  if (rejected) return rejected;

  const parsed = parseInput(updateAgentSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await updateAgentWith(agentEditor, parsed.data);
  if (result.done) revalidateAgents(parsed.data.agentId);
  return result;
}

/** Duplicates an agent under a new name; the copy starts in Strict mode. Lands on the copy's page. */
export async function duplicateAgentAction(
  _prev: AgentEditState,
  formData: FormData,
): Promise<AgentEditState> {
  const rejected = await rejectAgentCredentialForEdit();
  if (rejected) return rejected;

  const parsed = parseInput(duplicateAgentSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await duplicateAgentWith(agentEditor, parsed.data);
  if (!result.createdId) return result;
  revalidatePath("/app/agents");
  redirect(`/app/agents/${result.createdId}`);
}

/** Archives an agent: it keeps its history but can no longer receive tasks. The owner can unarchive it. */
export async function archiveAgentAction(
  _prev: AgentEditState,
  formData: FormData,
): Promise<AgentEditState> {
  const rejected = await rejectAgentCredentialForEdit();
  if (rejected) return rejected;

  const parsed = parseInput(agentRefSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await archiveAgentWith(agentEditor, parsed.data);
  if (result.done) revalidateAgents(parsed.data.agentId);
  return result;
}

export async function unarchiveAgentAction(
  _prev: AgentEditState,
  formData: FormData,
): Promise<AgentEditState> {
  const rejected = await rejectAgentCredentialForEdit();
  if (rejected) return rejected;

  const parsed = parseInput(agentRefSchema, formDataToRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await unarchiveAgentWith(agentEditor, parsed.data);
  if (result.done) revalidateAgents(parsed.data.agentId);
  return result;
}
