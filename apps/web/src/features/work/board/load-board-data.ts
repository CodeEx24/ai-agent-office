import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";

import type { BoardData } from "./board-types";

/**
 * One read of the board's non-event data (AGO-146): tasks, the runs that tie run ids to tasks, the workspace's
 * pending approvals and the agent names. READ ONLY, and it takes any Supabase client, so the server page (server
 * client) and the browser poll (user-scoped browser client) share this one code path.
 *
 * Every query names the workspace and runs as the signed-in user, so row-level security applies (any member or
 * viewer may read these tables). Never pass a service-role client. Nothing here writes.
 */

/** Newest tasks the board loads (by last update). */
export const MAX_BOARD_TASKS = 200;
/** Newest runs that belong to a task. Runs of older tasks fall back to the stream and are mapped by a later read. */
export const MAX_BOARD_RUNS = 1_000;
export const MAX_BOARD_APPROVALS = 100;
export const MAX_BOARD_AGENTS = 200;

/** A read failed. The message is fixed; the database error stays in `cause` and never reaches the screen. */
export class BoardLoadError extends Error {
  constructor(cause?: unknown) {
    super("Could not load the task board.", { cause });
    this.name = "BoardLoadError";
  }
}

export async function loadBoardData(
  client: SupabaseClient<Database>,
  workspaceId: string,
): Promise<BoardData> {
  const [tasks, runs, approvals, agents] = await Promise.all([
    client
      .from("tasks")
      .select("id, title, status, agent_id, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(MAX_BOARD_TASKS),
    client
      .from("runs")
      .select("id, task_id, agent_id, status, created_at")
      .eq("workspace_id", workspaceId)
      .not("task_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(MAX_BOARD_RUNS),
    client
      .from("approvals")
      .select("id, run_id, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_BOARD_APPROVALS),
    client
      .from("agents")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .limit(MAX_BOARD_AGENTS),
  ]);
  for (const result of [tasks, runs, approvals, agents]) {
    if (result.error) throw new BoardLoadError(result.error);
  }

  return {
    workspaceId,
    tasks: (tasks.data ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agentId: t.agent_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
    runs: (runs.data ?? []).flatMap((r) =>
      r.task_id === null
        ? []
        : [
            {
              id: r.id,
              taskId: r.task_id,
              agentId: r.agent_id,
              status: r.status,
              createdAt: r.created_at,
            },
          ],
    ),
    approvals: (approvals.data ?? []).map((a) => ({
      id: a.id,
      runId: a.run_id,
      createdAt: a.created_at,
    })),
    agents: (agents.data ?? []).map((a) => ({ id: a.id, name: a.name })),
  };
}
