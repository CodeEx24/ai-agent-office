import { GOAL_MESSAGES, type SubmitGoalInput } from "@ago/shared";

import { WorkspaceAccessError } from "../workspaces/workspace-access";
import { GoalInboxError, type GoalSubmitter } from "./goal-inbox";

/** What the form shows after a submit. `submittedId` is set once, on success. */
export interface GoalInboxState {
  error?: string;
  /** Message for the goal text field itself (empty, too long). */
  fieldError?: string;
  submittedId?: string;
}

/** Turns a thrown error into state that is safe to show. Unknown errors are not leaked. */
function stateFor(error: unknown): GoalInboxState {
  if (error instanceof WorkspaceAccessError) {
    return {
      error:
        error.code === "unauthenticated" ? GOAL_MESSAGES.sessionExpired : GOAL_MESSAGES.forbidden,
    };
  }
  if (error instanceof GoalInboxError) {
    switch (error.code) {
      case "forbidden":
        return { error: GOAL_MESSAGES.forbidden };
      case "invalid":
        return { fieldError: GOAL_MESSAGES.required };
      case "no_manager":
        return { error: GOAL_MESSAGES.noManager };
      case "failed":
        return { error: GOAL_MESSAGES.generic };
    }
  }
  return { error: GOAL_MESSAGES.generic };
}

/** Submits an already validated goal and returns the state to show. Pure apart from the submitter. */
export async function submitGoalWith(
  submitter: GoalSubmitter,
  input: SubmitGoalInput,
): Promise<GoalInboxState> {
  try {
    const { id } = await submitter.submitGoal(input);
    return { submittedId: id };
  } catch (error) {
    return stateFor(error);
  }
}
