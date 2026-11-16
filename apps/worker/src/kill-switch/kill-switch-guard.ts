import type { KillSwitchTarget } from "@ago/shared";
import type pg from "pg";

/**
 * The kill switch latch as the worker sees it (AGO-84). A person activates a scope (the whole workspace, or one
 * agent) through the human-only route; from then on, nothing may start in that scope until a person releases it.
 *
 * The worker asks in two places, both fail closed (a failed read throws, it never answers "not killed"):
 *  - the agent loop, in the same read as the human pause and stop flags (`readRunControl`), so a latched scope
 *    stops a run before its next tool call, including a run created after the switch was activated;
 *  - the credential issuer, so no credential is minted in a latched scope.
 * Running runs are told to stop by the activation itself (it sets their stop flag), so the latch is what keeps
 * the scope shut for everything else.
 */
export interface KillSwitchGuard {
  isKilled(target: KillSwitchTarget): Promise<boolean>;
}

/** Thrown when something tries to start in a latched scope. Carries no ids. */
export class KillSwitchActiveError extends Error {
  constructor() {
    super("the kill switch is active for this scope: nothing starts until a person releases it");
    this.name = "KillSwitchActiveError";
  }
}

/** No switch at all: used by tests and by a loop built without one. */
export const noopKillSwitchGuard: KillSwitchGuard = {
  isKilled: () => Promise.resolve(false),
};

/**
 * The database-backed guard. `private.kill_switches` has no grants for web roles; the worker's own connection reads
 * it. One row per activation; a row with `released_at is null` is live. A workspace row covers every agent in the
 * workspace; an agent row covers that agent only.
 */
export function createPgKillSwitchGuard(pool: pg.Pool): KillSwitchGuard {
  return {
    async isKilled({ workspaceId, agentId }) {
      const result = await pool.query<{ is_killed: boolean }>(
        `select exists (
           select 1 from private.kill_switches k
            where k.workspace_id = $1
              and k.released_at is null
              and (k.scope = 'workspace' or (k.scope = 'agent' and k.agent_id = $2))
         ) as is_killed`,
        [workspaceId, agentId],
      );
      return result.rows[0]?.is_killed === true;
    },
  };
}
