import {
  AGENT_MESSAGES,
  isAgentModelId,
  type AgentField,
  type AgentRefInput,
  type DuplicateAgentInput,
  type UpdateAgentInput,
} from "@ago/shared";

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { GENERIC_ERROR } from "./create-agent";

/**
 * Edit, duplicate, archive and unarchive an agent (AGO-89). The logic and the error mapping live here, behind
 * the `AgentEditor` interface, so they can be unit tested without a database or an endpoint (everything
 * exported from the "use server" file becomes a callable endpoint). `agent-editor.ts` is the real editor.
 */

export type AgentEditErrorCode =
  "forbidden" | "not_found" | "archived" | "stale" | "name_taken" | "invalid" | "failed";

/** Thrown by an editor. Carries a code and optionally the field it belongs to; the message is never shown. */
export class AgentEditError extends Error {
  constructor(
    readonly code: AgentEditErrorCode,
    readonly field?: AgentField,
  ) {
    super(`Agent edit error: ${code}`);
    this.name = "AgentEditError";
  }
}

/** The four writes. Each is one database call that also records the version; a seam for tests. */
export interface AgentEditor {
  /** Returns the new version number. Refused when `expectedVersion` is no longer the current version. */
  updateAgent(input: UpdateAgentInput): Promise<{ version: number }>;
  /** Copies the settings, skills and capabilities of the source into a new agent that starts in Strict mode. */
  duplicateAgent(input: DuplicateAgentInput): Promise<{ id: string }>;
  archiveAgent(input: AgentRefInput): Promise<void>;
  unarchiveAgent(input: AgentRefInput): Promise<void>;
}

/** Per-field messages plus one message for the form as a whole. `done` is set when the write happened. */
export interface AgentEditState {
  fieldErrors?: Partial<Record<AgentField, string>>;
  error?: string;
  done?: boolean;
  version?: number;
  createdId?: string;
}

export const OWNER_ONLY_EDIT_ERROR = "Only workspace owners can change agents.";
export const AGENT_CREDENTIAL_EDIT_ERROR =
  "Agents cannot change agents. This action is for people only.";
export const STALE_ERROR =
  "Someone else changed this agent after you opened it. Reload the page to see the latest version, then make your change again.";
export const ARCHIVED_ERROR = "This agent is archived. Unarchive it first.";
export const NOT_FOUND_ERROR = "This agent does not exist in this workspace.";
export const NAME_TAKEN_FIELD_ERROR = "Name is already used by another agent. Pick another name.";

/** Turns a thrown error into state that is safe to show. Nothing from the database is passed on. */
function stateFor(error: unknown): AgentEditState {
  if (error instanceof WorkspaceAccessError) {
    return {
      error:
        error.code === "unauthenticated"
          ? "Your session has expired. Please sign in again."
          : OWNER_ONLY_EDIT_ERROR,
    };
  }
  if (error instanceof AgentEditError) {
    switch (error.code) {
      case "forbidden":
        return { error: OWNER_ONLY_EDIT_ERROR };
      case "not_found":
        return { error: NOT_FOUND_ERROR };
      case "archived":
        return { error: ARCHIVED_ERROR };
      case "stale":
        return { error: STALE_ERROR };
      case "name_taken":
        return { fieldErrors: { name: NAME_TAKEN_FIELD_ERROR } };
      case "invalid":
        if (error.field === "model") return { fieldErrors: { model: AGENT_MESSAGES.modelUnknown } };
        if (error.field === "thinkingEffort") {
          return { fieldErrors: { thinkingEffort: AGENT_MESSAGES.thinkingEffortUnknown } };
        }
        if (error.field === "dailyBudget") {
          return { fieldErrors: { dailyBudget: AGENT_MESSAGES.budgetTooHigh } };
        }
        return { error: GENERIC_ERROR };
      case "failed":
        break;
    }
  }
  return { error: GENERIC_ERROR };
}

/**
 * Saves the six editable settings through `editor`, from input already validated with `updateAgentSchema`.
 * Owners only (the editor and the database both check). A model off the allowlist is refused here as well as
 * in the schema, because the database does not check it.
 */
export async function updateAgentWith(
  editor: AgentEditor,
  input: UpdateAgentInput,
): Promise<AgentEditState> {
  if (!isAgentModelId(input.model)) {
    return { fieldErrors: { model: AGENT_MESSAGES.modelUnknown } };
  }
  try {
    const { version } = await editor.updateAgent(input);
    return { done: true, version };
  } catch (error) {
    return stateFor(error);
  }
}

/** Duplicates an agent. The copy always starts in Strict mode: nothing in the input can say otherwise. */
export async function duplicateAgentWith(
  editor: AgentEditor,
  input: DuplicateAgentInput,
): Promise<AgentEditState> {
  try {
    const { id } = await editor.duplicateAgent(input);
    return { done: true, createdId: id };
  } catch (error) {
    return stateFor(error);
  }
}

export async function archiveAgentWith(
  editor: AgentEditor,
  input: AgentRefInput,
): Promise<AgentEditState> {
  try {
    await editor.archiveAgent(input);
    return { done: true };
  } catch (error) {
    return stateFor(error);
  }
}

export async function unarchiveAgentWith(
  editor: AgentEditor,
  input: AgentRefInput,
): Promise<AgentEditState> {
  try {
    await editor.unarchiveAgent(input);
    return { done: true };
  } catch (error) {
    return stateFor(error);
  }
}
