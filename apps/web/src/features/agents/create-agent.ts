import {
  AGENT_MESSAGES,
  fieldErrorsFromIssues,
  isAgentModelId,
  type AgentField,
  type CreateAgentInput,
} from "@ago/shared";

import { formDataToRecord } from "../../lib/validation/parse-input";
import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { AgentLibraryError, type AgentCreator } from "./agent-library";

/** Per-field messages (each names its field) plus one message for the form as a whole. */
export interface AgentWizardState {
  fieldErrors?: Partial<Record<AgentField, string>>;
  error?: string;
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
const OWNER_ONLY_ERROR = "Only workspace owners can create agents.";
const APPROVAL_ERROR = "Capabilities: a Tier 3 or 4 capability always needs a person's approval.";

/** The form sends skills and capabilities as JSON text; anything that is not JSON is refused as input. */
export function agentFormRecord(formData: FormData): Record<string, unknown> {
  const record: Record<string, unknown> = formDataToRecord(formData);
  for (const key of ["skillIds", "capabilities"]) {
    const raw = record[key];
    if (typeof raw !== "string") continue;
    try {
      record[key] = JSON.parse(raw) as unknown;
    } catch {
      record[key] = null; // fails the array check, reported against that field
    }
  }
  return record;
}

/** Turns a thrown error into state that is safe to show. */
function stateFor(error: unknown): AgentWizardState {
  if (error instanceof WorkspaceAccessError) {
    return {
      error:
        error.code === "unauthenticated"
          ? "Your session has expired. Please sign in again."
          : OWNER_ONLY_ERROR,
    };
  }
  if (error instanceof AgentLibraryError) {
    switch (error.code) {
      case "name_taken":
        return {
          fieldErrors: { name: "Name is already used by another agent. Pick another name." },
        };
      case "forbidden":
        return { error: OWNER_ONLY_ERROR };
      case "not_found":
        return error.field === "skillIds"
          ? { fieldErrors: { skillIds: "Skills: one of them does not exist in this workspace." } }
          : {
              fieldErrors: {
                capabilities: "Capabilities: one of them is not available in this workspace.",
              },
            };
      case "invalid":
        if (error.field === "model") return { fieldErrors: { model: AGENT_MESSAGES.modelUnknown } };
        return {
          fieldErrors: {
            capabilities: error.message.startsWith("Capabilities:")
              ? error.message
              : APPROVAL_ERROR,
          },
        };
      case "failed":
        break;
    }
  }
  return { error: GENERIC_ERROR };
}

/** Field errors for input that failed validation. Each message names its field. */
export function invalidInputState(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): AgentWizardState {
  const { form, ...fieldErrors } = fieldErrorsFromIssues(issues);
  return { fieldErrors, ...(form ? { error: form } : {}) };
}

/**
 * Creates the agent through `creator` from input that was already validated with `createAgentSchema`.
 * Owners only; the agent, its skills and its capability grants are created in one transaction and the agent
 * is always Strict. The creator is a parameter so the logic can be tested without a database. Lives outside
 * the "use server" file because everything exported from there becomes a callable endpoint.
 */
export async function createAgentWith(
  creator: AgentCreator,
  input: CreateAgentInput,
): Promise<AgentWizardState & { createdId?: string }> {
  // AGO-94 defence in depth: the input was validated upstream, but a caller that skipped that must not
  // reach the RPC with a model off the allowlist (the database does not check it).
  if (!isAgentModelId(input.model)) {
    return { fieldErrors: { model: AGENT_MESSAGES.modelUnknown } };
  }
  try {
    const { id } = await creator.createAgent(input);
    return { createdId: id };
  } catch (error) {
    return stateFor(error);
  }
}
