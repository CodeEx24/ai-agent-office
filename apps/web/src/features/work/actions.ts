"use server";

import { revalidatePath } from "next/cache";
import { GOAL_MESSAGES, submitGoalSchema } from "@ago/shared";

import { isAgentCredentialRequest } from "../../lib/auth/human-only";
import { formDataToRecord, parseInput } from "../../lib/validation/parse-input";
import { goalSubmitter } from "./goal-inbox";
import { submitGoalWith, type GoalInboxState } from "./submit-goal";

/**
 * Submits a goal from the inbox form (AGO-113). People only: a request that carries an agent credential is refused
 * first, before any validation or write (AGO-148). Then the input is validated (empty, zero-width-only and too-long
 * text are refused with a message for the field), and `submit_goal` records the goal and the Manager's task in one
 * transaction. The logic lives in `submit-goal.ts` so it can be tested without an endpoint.
 */
export async function submitGoalAction(
  _previous: GoalInboxState,
  formData: FormData,
): Promise<GoalInboxState> {
  if (await isAgentCredentialRequest()) return { error: GOAL_MESSAGES.agentCredential };

  const record = formDataToRecord(formData);
  const parsed = parseInput(
    submitGoalSchema,
    { workspaceId: record.workspaceId, text: record.text },
    GOAL_MESSAGES.generic,
  );
  if (!parsed.success) return { fieldError: parsed.message };

  const state = await submitGoalWith(goalSubmitter, parsed.data);
  if (state.submittedId) revalidatePath("/app/goals");
  return state;
}
