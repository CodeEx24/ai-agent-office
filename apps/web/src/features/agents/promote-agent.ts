import { AGENT_MODE_MESSAGES, type SetAgentModeInput } from "@ago/shared";

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { GENERIC_ERROR } from "./create-agent";
import { ARCHIVED_ERROR, NOT_FOUND_ERROR, OWNER_ONLY_EDIT_ERROR } from "./edit-agent";

/**
 * Change an agent's mode: promotion out of Strict, or demotion back (AGO-99). The logic and the error mapping
 * live here, behind the `AgentModeEditor` interface, so they can be unit tested without a database or an
 * endpoint (everything exported from the "use server" file becomes a callable endpoint).
 * `agent-mode-editor.ts` is the real editor.
 */

export type AgentModeErrorCode =
  "forbidden" | "not_found" | "archived" | "unchanged" | "invalid" | "failed";

/** Thrown by an editor. The message is never shown. */
export class AgentModeError extends Error {
  constructor(readonly code: AgentModeErrorCode) {
    super(`Agent mode error: ${code}`);
    this.name = "AgentModeError";
  }
}

/** The one write. A single database call that also appends the log row; a seam for tests. */
export interface AgentModeEditor {
  setAgentMode(input: SetAgentModeInput): Promise<void>;
}

/** `done` is set when the mode changed and the change was logged. */
export interface AgentModeState {
  fieldErrors?: { mode?: string; confirm?: string };
  error?: string;
  done?: boolean;
}

export const AGENT_CREDENTIAL_MODE_ERROR =
  "Agents cannot change an agent's mode, not even their own. This action is for people only.";
export const MODE_UNCHANGED_ERROR = "The agent is already in that mode.";

function stateFor(error: unknown): AgentModeState {
  if (error instanceof WorkspaceAccessError) {
    return {
      error:
        error.code === "unauthenticated"
          ? "Your session has expired. Please sign in again."
          : OWNER_ONLY_EDIT_ERROR,
    };
  }
  if (error instanceof AgentModeError) {
    switch (error.code) {
      case "forbidden":
        return { error: OWNER_ONLY_EDIT_ERROR };
      case "not_found":
        return { error: NOT_FOUND_ERROR };
      case "archived":
        return { error: ARCHIVED_ERROR };
      case "unchanged":
        return { error: MODE_UNCHANGED_ERROR };
      case "invalid":
        return { fieldErrors: { mode: AGENT_MODE_MESSAGES.modeUnknown } };
      case "failed":
        break;
    }
  }
  return { error: GENERIC_ERROR };
}

/**
 * Sets the mode through `editor`, from input already validated with `setAgentModeSchema` (an allowed mode, the
 * confirm box ticked). Owners only: the editor and the database both check. Never throws.
 */
export async function setAgentModeWith(
  editor: AgentModeEditor,
  input: SetAgentModeInput,
): Promise<AgentModeState> {
  try {
    await editor.setAgentMode(input);
    return { done: true };
  } catch (error) {
    return stateFor(error);
  }
}
