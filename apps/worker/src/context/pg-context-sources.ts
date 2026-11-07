import { agentProfileSchema, assignedSkillSchema, taskPacketSchema } from "@ago/shared";
import { z } from "zod";

import type { ContextScope, RunContext, RunContextSource } from "./context-builder.js";
import type { AssignedSkill } from "@ago/shared";

/** The part of `pg.Pool` / `pg.PoolClient` this module uses, so a test can pass one transaction client. */
export interface Queryable {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

const runRowSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_description: z.string(),
  agent_archived: z.boolean(),
  task_id: z.string().nullable(),
  task_title: z.string().nullable(),
  task_description: z.string().nullable(),
});

const skillRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  version: z.number(),
  body: z.string(),
});

/**
 * Postgres source for the context builder. The worker connects with a service connection that
 * BYPASSES row level security, so the filters below are the only guard: every statement names
 * `workspace_id` explicitly and joins on the composite `(workspace_id, id)` keys. The run row supplies
 * the workspace; nothing else is read from a caller-supplied id alone.
 *
 * Agent role and prompt: `agents` has no prompt column yet (the agent wizard, AGO-141, adds one), so the
 * role is `agents.description` and the prompt is null until then.
 *
 * Skill origin: `skills` has no origin column. Every skill row today was written through the owner-only
 * skill library (AGO-128), and no pack import exists yet, so each row is `owner`. When the pack import
 * (AGO-191) stores skills it must record the origin, and this mapping must read it.
 *
 * Skill version: assignments follow the skill's latest version (AGO-128 has no pin column), and
 * `skills.version` / `skills.body` mirror the newest `skill_versions` row.
 */
export function createPgRunContextSource(db: Queryable): RunContextSource {
  return {
    async loadRun(runId: string): Promise<RunContext | null> {
      const result = await db.query(
        `select r.workspace_id, r.agent_id,
                a.name as agent_name, a.description as agent_description,
                (a.archived_at is not null) as agent_archived,
                t.id as task_id, t.title as task_title, t.description as task_description
           from public.runs r
           join public.agents a on a.workspace_id = r.workspace_id and a.id = r.agent_id
           left join public.tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
          where r.id = $1`,
        [runId],
      );
      const first: unknown = result.rows[0];
      if (first === undefined) return null;
      const row = runRowSchema.parse(first);
      const task =
        row.task_id === null
          ? null
          : taskPacketSchema.parse({
              id: row.task_id,
              workspaceId: row.workspace_id,
              title: row.task_title ?? "",
              description: row.task_description ?? "",
            });
      return {
        runId,
        workspaceId: row.workspace_id,
        agent: agentProfileSchema.parse({
          id: row.agent_id,
          workspaceId: row.workspace_id,
          name: row.agent_name,
          role: row.agent_description,
          prompt: null,
        }),
        task,
        agentArchived: row.agent_archived,
      };
    },

    async loadAssignedSkills(scope: ContextScope): Promise<readonly AssignedSkill[]> {
      const result = await db.query(
        `select s.id, s.workspace_id, a.agent_id, s.name, s.version, s.body
           from public.agent_skills a
           join public.skills s on s.workspace_id = a.workspace_id and s.id = a.skill_id
          where a.workspace_id = $1 and a.agent_id = $2
          order by s.name, s.id`,
        [scope.workspaceId, scope.agentId],
      );
      return result.rows.map((raw) => {
        const row = skillRowSchema.parse(raw);
        return assignedSkillSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          name: row.name,
          version: row.version,
          origin: "owner",
          body: row.body,
        });
      });
    },
  };
}
