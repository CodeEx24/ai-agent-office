import {
  capabilityTierSchema,
  parsePolicyAgentMode,
  policyLevelSchema,
  policyRuleSchema,
  type PolicyEngineAgent,
  type PolicyEngineLayer,
} from "@ago/shared";
import { z } from "zod";

import type { Queryable } from "../context/pg-context-sources.js";

/**
 * What the policy engine needs for one agent: its mode, its capability grants and every active policy
 * that applies to it. Loaded from the database on every check (policy is never read from vault files,
 * and an owner's change applies to the very next tool call).
 */
export interface PolicyScope {
  readonly workspaceId: string;
  readonly agentId: string;
}

export interface PolicyInputs {
  readonly agent: PolicyEngineAgent;
  readonly policies: readonly PolicyEngineLayer[];
}

export interface PolicySource {
  load(scope: PolicyScope): Promise<PolicyInputs>;
}

const agentRowSchema = z.object({ mode: z.string(), department_id: z.string().nullable() });

const grantRowSchema = z.object({
  capability: z.string(),
  grant_tier: capabilityTierSchema,
  catalog_tier: capabilityTierSchema.nullable(),
  mode: z.enum(["automatic", "approval"]),
  catalog_enabled: z.boolean().nullable(),
});

const policyRowSchema = z.object({ id: z.string(), level: policyLevelSchema, rule: z.unknown() });

/**
 * Postgres source. The worker connects with a service connection that BYPASSES row level security, so
 * every statement names `workspace_id` explicitly and the run's agent decides which policies apply.
 *
 * Layers: baseline (workspace wide), department (the agent's `department_id`) and agent. There is no
 * team membership yet (teams arrive with AGO-108), so team policies are not loaded until agents can
 * belong to a team.
 *
 * Fail closed: a missing agent throws (the loop turns that into a deny); a grant whose catalog row is
 * missing counts as disabled; a policy whose JSON fails `policyRuleSchema` is passed on with `rule: null`,
 * which makes the engine deny everything.
 */
export function createPgPolicySource(db: Queryable): PolicySource {
  return {
    async load(scope: PolicyScope): Promise<PolicyInputs> {
      const agentResult = await db.query(
        `select mode, department_id from public.agents where workspace_id = $1 and id = $2`,
        [scope.workspaceId, scope.agentId],
      );
      const agentRaw: unknown = agentResult.rows[0];
      if (agentRaw === undefined) throw new Error("policy: agent not found in workspace");
      const agentRow = agentRowSchema.parse(agentRaw);

      const grantResult = await db.query(
        `select ac.capability, ac.tier as grant_tier, c.tier as catalog_tier, ac.mode,
                c.enabled as catalog_enabled
           from public.agent_capabilities ac
           left join public.capabilities c
             on c.workspace_id = ac.workspace_id and c.key = ac.capability
          where ac.workspace_id = $1 and ac.agent_id = $2
          order by ac.capability`,
        [scope.workspaceId, scope.agentId],
      );
      const grants = grantResult.rows.map((raw) => {
        const row = grantRowSchema.parse(raw);
        return {
          capabilityKey: row.capability,
          // The higher of the grant's and the catalog's tier: neither can lower the other.
          tier: capabilityTierSchema.parse(Math.max(row.grant_tier, row.catalog_tier ?? 0)),
          mode: row.mode,
          isEnabled: row.catalog_enabled === true,
        };
      });

      const policyResult = await db.query(
        `select id, level, rule
           from public.policies
          where workspace_id = $1
            and archived_at is null
            and (
              level = 'baseline'
              or (level = 'department' and scope_id = $3::uuid)
              or (level = 'agent' and scope_id = $2::uuid)
            )
          order by level, id`,
        [scope.workspaceId, scope.agentId, agentRow.department_id],
      );
      const policies = policyResult.rows.map((raw): PolicyEngineLayer => {
        const row = policyRowSchema.parse(raw);
        const rule = policyRuleSchema.safeParse(row.rule);
        return { id: row.id, level: row.level, rule: rule.success ? rule.data : null };
      });

      return {
        agent: { mode: parsePolicyAgentMode(agentRow.mode), grants },
        policies,
      };
    },
  };
}
