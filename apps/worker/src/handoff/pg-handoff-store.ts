import { capabilityTierSchema, effectiveDailyBudgetCents } from "@ago/shared";
import { narrowedPermissionsSchema } from "@ago/shared/handoff";
import { z } from "zod";

import type { HandoffRecord, HandoffStore } from "./handoff-store.js";
import type { Queryable } from "../context/pg-context-sources.js";
import type { HandoffChain, HandoffGrant, HandoffParty } from "@ago/shared/handoff";

/**
 * Postgres `HandoffStore` (AGO-81). The worker's connection bypasses row level security, so every statement names
 * `workspace_id` and joins on the composite keys. Writes go only through the two SECURITY DEFINER functions
 * (`create_handoff_task`, `accept_handoff_task`): the database re-derives the sender, the requester and the chain from
 * the sender's run and refuses anything wider than the sender holds. Reads fail closed: a missing agent or run is null.
 *
 * Data scope: agents have no stored vault scope yet, so a party's scope is empty (no data passes on in a handoff)
 * until a scope source exists (follow-up with AGO-188). Empty is the safe direction: the intersection can only shrink.
 */
const agentRowSchema = z.object({
  archived_at: z.union([z.string(), z.date()]).nullable(),
  daily_budget_cents: z.number().nullable(),
  used_cents: z.coerce.number(),
});

const grantRowSchema = z.object({
  capability: z.string(),
  grant_tier: capabilityTierSchema,
  catalog_tier: capabilityTierSchema.nullable(),
  mode: z.enum(["automatic", "approval"]),
  catalog_enabled: z.boolean().nullable(),
});

const chainRowSchema = z.object({
  agent_id: z.string(),
  created_by: z.string().nullable(),
  handoff_from_agent_id: z.string().nullable(),
  requester_member_id: z.string().nullable(),
  handoff_path: z.array(z.string()).nullable(),
});

const taskRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  handoff_from_agent_id: z.string(),
  agent_id: z.string(),
  requester_member_id: z.string(),
  handoff_path: z.array(z.string()),
  handoff_depth: z.number(),
  handoff_grants: z.unknown(),
  title: z.string(),
  description: z.string(),
  handoff_run_id: z.string().nullable(),
});

const TASK_COLUMNS = `id, workspace_id, handoff_from_agent_id, agent_id, requester_member_id,
  handoff_path::text[] as handoff_path, handoff_depth, handoff_grants, title, description, handoff_run_id`;

function toRecord(raw: unknown): HandoffRecord {
  const row = taskRowSchema.parse(raw);
  return {
    taskId: row.id,
    workspaceId: row.workspace_id,
    fromAgentId: row.handoff_from_agent_id,
    senderRunId: null,
    toAgentId: row.agent_id,
    requesterMemberId: row.requester_member_id,
    path: row.handoff_path,
    depth: row.handoff_depth,
    narrowed: narrowedPermissionsSchema.parse(row.handoff_grants),
    title: row.title,
    description: row.description,
    acceptedByRunId: row.handoff_run_id,
  };
}

export function createPgHandoffStore(db: Queryable): HandoffStore {
  return {
    async loadParty(workspaceId, agentId): Promise<HandoffParty | null> {
      const agentResult = await db.query(
        `select a.archived_at, a.daily_budget_cents,
                coalesce((select b.cost_used_cents from public.budgets_usage b
                           where b.workspace_id = a.workspace_id and b.agent_id = a.id
                             and b.period_start = (now() at time zone 'utc')::date), 0) as used_cents
           from public.agents a
          where a.workspace_id = $1 and a.id = $2`,
        [workspaceId, agentId],
      );
      const agentRaw: unknown = agentResult.rows[0];
      if (agentRaw === undefined) return null;
      const agent = agentRowSchema.parse(agentRaw);

      const grantResult = await db.query(
        `select ac.capability, ac.tier as grant_tier, c.tier as catalog_tier, ac.mode,
                c.enabled as catalog_enabled
           from public.agent_capabilities ac
           left join public.capabilities c
             on c.workspace_id = ac.workspace_id and c.key = ac.capability
          where ac.workspace_id = $1 and ac.agent_id = $2
          order by ac.capability`,
        [workspaceId, agentId],
      );
      const grants = grantResult.rows.map((raw): HandoffGrant => {
        const row = grantRowSchema.parse(raw);
        return {
          capabilityKey: row.capability,
          // The higher of the grant's and the catalog's tier, as the policy engine reads it.
          tier: capabilityTierSchema.parse(Math.max(row.grant_tier, row.catalog_tier ?? 0)),
          mode: row.mode,
          isEnabled: row.catalog_enabled === true,
        };
      });

      return {
        agentId,
        workspaceId,
        isArchived: agent.archived_at !== null,
        grants,
        budgetCents: Math.max(
          0,
          effectiveDailyBudgetCents(agent.daily_budget_cents) - agent.used_cents,
        ),
        dataScope: [],
      };
    },

    async loadChainForRun(workspaceId, runId): Promise<HandoffChain | null> {
      const result = await db.query(
        `select r.agent_id, t.created_by, t.handoff_from_agent_id, t.requester_member_id,
                t.handoff_path::text[] as handoff_path
           from public.runs r
           join public.tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
          where r.workspace_id = $1 and r.id = $2`,
        [workspaceId, runId],
      );
      const raw: unknown = result.rows[0];
      if (raw === undefined) return null;
      const row = chainRowSchema.parse(raw);
      if (row.handoff_from_agent_id !== null) {
        if (row.requester_member_id === null || row.handoff_path === null) return null;
        return { workspaceId, requesterMemberId: row.requester_member_id, path: row.handoff_path };
      }
      // An ordinary task: the human who created it is the requester, and the chain starts at the run's agent.
      if (row.created_by === null) return null;
      return { workspaceId, requesterMemberId: row.created_by, path: [row.agent_id] };
    },

    async insert(record): Promise<void> {
      if (record.senderRunId === null) throw new Error("handoff insert needs the sender's run");
      await db.query(
        `select public.create_handoff_task($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid,
                                           $8::uuid[], $9::int, $10::jsonb)`,
        [
          record.workspaceId,
          record.senderRunId,
          record.taskId,
          record.toAgentId,
          record.title,
          record.description,
          record.requesterMemberId,
          record.path,
          record.depth,
          JSON.stringify(record.narrowed),
        ],
      );
    },

    async findByRun(workspaceId, runId): Promise<HandoffRecord | null> {
      // Through the run's own task, not the accept link: a run nobody accepted is still a run on a handoff task.
      const result = await db.query(
        `select ${TASK_COLUMNS} from public.tasks
          where workspace_id = $1 and handoff_from_agent_id is not null
            and id = (select r.task_id from public.runs r where r.workspace_id = $1 and r.id = $2)`,
        [workspaceId, runId],
      );
      const raw: unknown = result.rows[0];
      return raw === undefined ? null : toRecord(raw);
    },

    async spentCentsOnTask(workspaceId, taskId): Promise<number> {
      const result = await db.query(
        // Spend = the cost of budget.usage events plus the held cents of a call whose outcome is unknown
        // (budget.exceeded, reason call_outcome_unknown_charged, field "used": it may have been billed). The casts sit
        // inside the CASE, so a huge number never raises 22003 (Postgres may run a select-list expression before the
        // WHERE filter): 1..12 digits count as is, a longer all-digit value counts as a large number (it can only shrink
        // a budget), anything else counts 0. Same rule as the parent-spend query in create_handoff_task.
        `select coalesce(sum(case
                  when e.type = 'budget.usage' then
                    case when (e.payload ->> 'cost_cents') ~ '^[0-9]{1,12}$' then (e.payload ->> 'cost_cents')::bigint
                         when (e.payload ->> 'cost_cents') ~ '^[0-9]{13,}$' then 999999999999 else 0 end
                  when e.type = 'budget.exceeded' and e.payload ->> 'reason' = 'call_outcome_unknown_charged' then
                    case when (e.payload ->> 'used') ~ '^[0-9]{1,12}$' then (e.payload ->> 'used')::bigint
                         when (e.payload ->> 'used') ~ '^[0-9]{13,}$' then 999999999999 else 0 end
                  else 0 end), 0) as spent
           from public.run_events e
           join public.runs r on r.workspace_id = e.workspace_id and r.id = e.run_id
          where e.workspace_id = $1 and r.task_id = $2 and e.type in ('budget.usage', 'budget.exceeded')`,
        [workspaceId, taskId],
      );
      const raw = result.rows[0] as { spent?: unknown } | undefined;
      return z.coerce.number().parse(raw?.spent ?? 0);
    },

    async allocatedCentsOnRun(workspaceId, runId): Promise<number> {
      // The budgets this run's task already gave to its child handoffs (siblings of the one being made).
      const result = await db.query(
        `select coalesce(sum((t.handoff_grants ->> 'budgetCents')::bigint), 0) as allocated
           from public.tasks t
          where t.workspace_id = $1 and t.handoff_from_agent_id is not null
            and t.parent_task_id = (select r.task_id from public.runs r where r.workspace_id = $1 and r.id = $2)`,
        [workspaceId, runId],
      );
      const raw = result.rows[0] as { allocated?: unknown } | undefined;
      return z.coerce.number().parse(raw?.allocated ?? 0);
    },

    async findByTask(workspaceId, taskId): Promise<HandoffRecord | null> {
      const result = await db.query(
        `select ${TASK_COLUMNS} from public.tasks
          where workspace_id = $1 and id = $2 and handoff_from_agent_id is not null`,
        [workspaceId, taskId],
      );
      const raw: unknown = result.rows[0];
      return raw === undefined ? null : toRecord(raw);
    },

    async markAccepted(workspaceId, taskId, runId): Promise<boolean> {
      const result = await db.query(
        `select public.accept_handoff_task($1::uuid, $2::uuid, $3::uuid) as ok`,
        [workspaceId, taskId, runId],
      );
      const raw = result.rows[0] as { ok?: unknown } | undefined;
      return raw?.ok === true;
    },
  };
}
