"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAgentSchema } from "@ago/shared";

import { AgentCredentialRejectedError, requireHumanRequest } from "../../lib/auth/human-only";
import { parseInput } from "../../lib/validation/parse-input";
import { agentCreator } from "./agent-library";
import {
  agentFormRecord,
  createAgentWith,
  GENERIC_ERROR,
  invalidInputState,
  type AgentWizardState,
} from "./create-agent";

const AGENT_CREDENTIAL_ERROR = "Agents cannot create agents. This action is for people only.";

/**
 * Creates an agent from the wizard (AGO-141). Owners only; the agent, its skills and its capability grants
 * are created in one transaction and the agent is always Strict. Error mapping lives in `create-agent.ts` so
 * it can be unit tested; only this async function is exposed as an endpoint.
 */
export async function createAgentAction(
  _prev: AgentWizardState,
  formData: FormData,
): Promise<AgentWizardState> {
  try {
    // AGO-148: creating an agent is a human decision; an agent credential can never call it.
    await requireHumanRequest();
  } catch (error) {
    if (error instanceof AgentCredentialRejectedError) return { error: AGENT_CREDENTIAL_ERROR };
    throw error;
  }

  const parsed = parseInput(createAgentSchema, agentFormRecord(formData), GENERIC_ERROR);
  if (!parsed.success) return invalidInputState(parsed.issues);

  const result = await createAgentWith(agentCreator, parsed.data);
  if (!result.createdId) return result;
  revalidatePath("/app/agents");
  redirect("/app/agents");
}
