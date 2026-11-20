import { z } from "zod";

/** The approvals inbox (AGO-37): the existing human-only surface a card opens. */
export const APPROVALS_PATH = "/app/approvals";

/** Query of the approvals page when a card opened it. Untrusted: parsed with `parseInput` on the page. */
export const approvalLinkQuerySchema = z.object({
  approval: z.string().min(1).max(128).optional(),
});

/**
 * Where "Waiting on you" opens. It only navigates: the `approval` query lets the inbox say when that request
 * is no longer pending, and the fragment scrolls to its card. Deciding stays in the inbox (human-only route).
 */
export function approvalHref(approvalId: string | null): string {
  if (approvalId === null) return APPROVALS_PATH;
  const id = encodeURIComponent(approvalId);
  return `${APPROVALS_PATH}?approval=${id}#approval-${id}-title`;
}
