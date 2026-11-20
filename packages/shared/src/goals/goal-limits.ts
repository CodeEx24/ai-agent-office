/**
 * Goal inbox limits and text checks (AGO-113). Free of runtime imports (no zod) so the client form can import
 * it without pulling zod into the browser bundle (same reason as `agent-limits.ts`). The server validates with
 * the zod schema in `goal-schemas.ts`, which reuses everything here, and the database repeats the same rules in
 * a CHECK constraint and in `submit_goal`; a test keeps the three in step.
 */

/** Longest goal, in characters, after normalising. Mirrors the CHECK on `goals.text`. */
export const GOAL_TEXT_MAX_LENGTH = 5000;

export const GOAL_MESSAGES = {
  required: "Describe the goal. An empty goal cannot be submitted.",
  tooLong: `A goal can be at most ${String(GOAL_TEXT_MAX_LENGTH)} characters.`,
  noManager:
    "This workspace has no Manager agent yet. Create a Manager agent, then submit the goal again.",
  forbidden: "Only workspace members can submit goals.",
  agentCredential: "Agents cannot submit goals. This action is for people only.",
  sessionExpired: "Your session has expired. Please sign in again.",
  generic: "Something went wrong. Please try again.",
} as const;

// Zero-width and invisible characters: ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen, Mongolian vowel separator.
const INVISIBLE = "\\u200b-\\u200d\\u2060\\ufeff\\u00ad\\u180e";
const INVISIBLE_RE = new RegExp(`[${INVISIBLE}]`, "gu");
const BLANK_RE = new RegExp(`^[\\s${INVISIBLE}]*$`, "u");

/** CRLF (browser textareas) to LF, zero-width characters removed, then trimmed. The stored text is this. */
export function normalizeGoalText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(INVISIBLE_RE, "").trim();
}

/** True when nothing visible is left: empty, whitespace only, or zero-width characters only. */
export function isGoalTextBlank(text: string): boolean {
  return BLANK_RE.test(text);
}

export type GoalTextCheck = { ok: true; text: string } | { ok: false; message: string };

/** The one check the form and the server share. */
export function checkGoalText(raw: string): GoalTextCheck {
  const text = normalizeGoalText(raw);
  if (isGoalTextBlank(text)) return { ok: false, message: GOAL_MESSAGES.required };
  if (text.length > GOAL_TEXT_MAX_LENGTH) return { ok: false, message: GOAL_MESSAGES.tooLong };
  return { ok: true, text };
}
