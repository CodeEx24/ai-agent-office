import type { AgentRunLimitsSource } from "./run-limits.js";

/** The part of `pg.Pool` this module uses, so a test can pass a stub. */
interface Queryable {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * Reads `agents.run_limits` (AGO-166). The worker connects with a service connection that bypasses row level
 * security, so the statement names `workspace_id` and `id` together: an agent id alone never selects a row.
 * The value is untrusted: `mergeRunLimits` validates and clamps it. A missing agent answers null (defaults).
 */
export function createPgAgentRunLimitsSource(db: Queryable): AgentRunLimitsSource {
  return {
    async get({ workspaceId, agentId }) {
      const result = await db.query(
        "select run_limits from public.agents where workspace_id = $1 and id = $2",
        [workspaceId, agentId],
      );
      const row = result.rows[0] as { run_limits?: unknown } | undefined;
      return row?.run_limits ?? null;
    },
  };
}
