import { z } from "zod";

/**
 * Human-only run control (AGO-86): the body of `POST /api/runs/[id]/control` and the rule for which paths are
 * control routes. Pure schemas and one predicate: no I/O.
 */

export const RUN_CONTROL_ACTIONS = ["pause", "resume", "stop"] as const;
export type RunControlAction = (typeof RUN_CONTROL_ACTIONS)[number];

/** `.strict()`: a client sends the workspace and the action, nothing else. */
export const runControlBodySchema = z
  .object({
    workspace_id: z.uuid(),
    action: z.enum(RUN_CONTROL_ACTIONS),
  })
  .strict();
export type RunControlBody = z.infer<typeof runControlBodySchema>;

export const runIdParamSchema = z.uuid();

/**
 * What `public.request_run_control` answers: `accepted` (the request was recorded) or `not_applicable` (no such
 * run in this workspace, or the run is not in a state that action can reach, or it was already stopped).
 */
export const RUN_CONTROL_RESULTS = ["accepted", "not_applicable"] as const;
export const runControlResultSchema = z.enum(RUN_CONTROL_RESULTS);
export type RunControlResult = z.infer<typeof runControlResultSchema>;

/**
 * Control routes are for people only. The same shape the database function
 * `record_agent_approval_rejection` accepts for the `control_route_rejected` audit event.
 */
const RUN_CONTROL_ROUTE = /^\/api\/runs\/[0-9a-fA-F-]{36}\/control$/;

export function isRunControlRoute(pathname: string): boolean {
  return RUN_CONTROL_ROUTE.test(pathname);
}
