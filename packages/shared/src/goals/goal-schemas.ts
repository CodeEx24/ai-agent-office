import { z } from "zod";

import {
  GOAL_MESSAGES,
  GOAL_TEXT_MAX_LENGTH,
  isGoalTextBlank,
  normalizeGoalText,
} from "./goal-limits.js";

export * from "./goal-limits.js";

/**
 * Submitting a goal (AGO-113). Strict: no other keys. The text is normalised (CRLF, zero-width, trim) and then
 * must be non-empty and at most GOAL_TEXT_MAX_LENGTH. Goal text is untrusted data: this only checks its shape,
 * it never interprets it.
 */
export const goalTextSchema = z
  .string(GOAL_MESSAGES.required)
  .transform(normalizeGoalText)
  .pipe(
    z
      .string()
      .refine((text) => !isGoalTextBlank(text), GOAL_MESSAGES.required)
      .max(GOAL_TEXT_MAX_LENGTH, GOAL_MESSAGES.tooLong),
  );

export const submitGoalSchema = z.strictObject({
  workspaceId: z.uuid(),
  text: goalTextSchema,
});

export type SubmitGoalInput = z.output<typeof submitGoalSchema>;

/** A goal as listed in the inbox. */
export interface Goal {
  id: string;
  text: string;
  createdAt: string;
}
