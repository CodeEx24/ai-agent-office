import type { PackRejection } from "@ago/shared/pack-import-preview";

/**
 * Shared by the two pack import routes (the dry run, AGO-193, and the apply, AGO-194): the no-store header, the error
 * body and the status of each way a file can be refused. One place, so a dry run and the apply answer a bad file the
 * same way.
 */

// Never cache: the answer depends on the caller's session and describes the workspace's agents.
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function jsonError(error: string, status: number, extra: object = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: NO_STORE });
}

export const REJECTION_STATUS: Record<PackRejection["code"], number> = {
  too_large: 413,
  too_deep: 422,
  too_complex: 422,
  invalid_json: 422,
  not_a_pack: 422,
  too_many_agents: 422,
  too_many_skills: 422,
  too_many_notes: 422,
  invalid_pack: 422,
};
