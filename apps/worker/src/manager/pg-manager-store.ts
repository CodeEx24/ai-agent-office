import { z } from "zod";

import type { CreateGoalTasksRefusal, ManagerStore } from "./manager-store.js";
import type { Queryable } from "../context/pg-context-sources.js";

/**
 * Postgres `ManagerStore` (AGO-117). The worker's connection bypasses row level security, so every statement names
 * `workspace_id` and joins on the composite keys. The only write is `public.create_goal_tasks` (SECURITY DEFINER,
 * service_role); the rules live there and a refusal comes back as a fixed reason, never as database text.
 */
const goalRowSchema = z.object({ goal_id: z.string(), text: z.string() });
const idsRowSchema = z.object({ ids: z.array(z.string()) });

const pgErrorSchema = z.object({ code: z.string(), message: z.string().optional() });

function refusalOf(error: unknown): CreateGoalTasksRefusal | null {
  const parsed = pgErrorSchema.safeParse(error);
  if (!parsed.success) return null;
  const { code, message = "" } = parsed.data;
  if (code === "42501") return "not_manager";
  if (code === "P0002")
    return message.includes("agent") && message.includes("archived")
      ? "unknown_agent"
      : "goal_not_assigned";
  if (code === "22023") return message.includes("at most 24") ? "limit_reached" : "invalid";
  return null;
}

export function createPgManagerStore(db: Queryable): ManagerStore {
  return {
    async readGoalForRun(workspaceId, runId) {
      const result = await db.query(
        `select g.id as goal_id, g.text
           from public.runs r
           join public.agents a on a.workspace_id = r.workspace_id and a.id = r.agent_id
           join public.tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
           join public.goals g on g.workspace_id = t.workspace_id and g.id = t.goal_id
          where r.workspace_id = $1 and r.id = $2
            and t.agent_id = r.agent_id
            and a.archived_at is null and lower(btrim(a.role)) = 'manager'`,
        [workspaceId, runId],
      );
      const first: unknown = result.rows[0];
      if (first === undefined) return null;
      const row = goalRowSchema.parse(first);
      return { goalId: row.goal_id, text: row.text };
    },

    async createGoalTasks(input) {
      try {
        const result = await db.query(
          `select public.create_goal_tasks($1::uuid, $2::uuid, $3::uuid, $4::jsonb) as ids`,
          [input.workspaceId, input.runId, input.goalId, JSON.stringify(input.tasks)],
        );
        const first: unknown = result.rows[0];
        const row = idsRowSchema.parse(first);
        return { ok: true, taskIds: row.ids };
      } catch (error) {
        const reason = refusalOf(error);
        if (reason === null) throw error;
        return { ok: false, reason };
      }
    },
  };
}
