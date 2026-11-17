import { z } from "zod";

/**
 * The kill switch (AGO-84): the body of `POST /api/control/kill` and `POST /api/control/kill/release`, and the rule
 * for which paths are kill routes. Pure schemas and predicates: no I/O.
 *
 * A kill switch has a scope: the whole workspace, or one agent. While it is active, every live run in scope is
 * stopped, every credential in scope is revoked, and nothing new starts in scope (no credential is issued, a run
 * that is picked up is stopped before its first tool call).
 */

export const KILL_SWITCH_SCOPES = ["workspace", "agent"] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/**
 * `.strict()`: a client names the workspace and the scope, nothing else. An `agent` scope needs an `agent_id`; a
 * `workspace` scope must not carry one (an ambiguous request is refused, never guessed at).
 */
export const killSwitchBodySchema = z
  .object({
    workspace_id: z.uuid(),
    scope: z.enum(KILL_SWITCH_SCOPES),
    agent_id: z.uuid().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.scope === "agent" && body.agent_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "agent_id is required for an agent scope",
      });
    }
    if (body.scope === "workspace" && body.agent_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "agent_id is not allowed for a workspace scope",
      });
    }
  });
export type KillSwitchBody = z.infer<typeof killSwitchBodySchema>;

/** What the database functions answer: how many runs were told to stop and how many credentials were revoked. */
export const killSwitchResultSchema = z
  .object({
    runs_stopped: z.number().int().nonnegative(),
    credentials_revoked: z.number().int().nonnegative(),
  })
  .strict();
export type KillSwitchResult = z.infer<typeof killSwitchResultSchema>;

/** What `POST /api/control/kill` and `.../release` answer: the scope, the new state and the counts. */
export const killSwitchResponseSchema = z
  .object({
    scope: z.enum(KILL_SWITCH_SCOPES),
    status: z.enum(["active", "released"]),
    runs_stopped: z.number().int().nonnegative(),
    credentials_revoked: z.number().int().nonnegative(),
  })
  .strict();
export type KillSwitchResponse = z.infer<typeof killSwitchResponseSchema>;

/** Which scope a latch covers, as the worker asks about a run: its workspace and its agent. */
export interface KillSwitchTarget {
  readonly workspaceId: string;
  readonly agentId: string;
}

const KILL_SWITCH_ROUTE = /^\/api\/control\/kill(\/release)?$/;

/** Kill routes are for people only (the proxy and the handlers refuse an agent credential on them). */
export function isKillSwitchRoute(pathname: string): boolean {
  return KILL_SWITCH_ROUTE.test(pathname);
}
