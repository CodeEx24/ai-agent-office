import {
  buildImportOutcome,
  type ConflictRule,
  type ImportDisabledReason,
  type ImportPreview,
  type PreviewContext,
} from "./agent-pack-import-preview.js";
import type { AgentPack } from "./agent-pack-schemas.js";

/**
 * Agent pack import, the apply plan (AGO-194, epic EP-19). The write side of `buildImportPreview`.
 *
 * It is built from the SAME call as the preview (`buildImportOutcome`), so the report the owner saw is what the
 * plan applies: an agent the preview calls `create` is created, one it calls `skip` is not touched, a capability the
 * preview calls ignored is not in the plan. A test proves this on the same input.
 *
 * Only what the database needs is in the plan: names, the fields to write, the capability KEYS that survive the
 * Tier 3+ filter, the budget after the cap. Never a tier, a mode, an id, a secret reference or a note: the database
 * function reads tiers from its own catalog and never sets a mode. Plan text (prompts, skill bodies) is pack text and
 * travels as data to one function; it is never put in a report, an event or a log line.
 *
 * Node only, like the preview (it imports it).
 */

export interface ImportPlanAgent {
  /** The name to write: the pack's, or the renamed copy. */
  name: string;
  action: "create" | "update";
  role: string;
  model: string;
  thinking_effort: "low" | "medium" | "high";
  prompt: string;
  /** After the workspace cap: the pack's budget, or the default when it was above the cap. */
  daily_budget_cents: number;
  /** Catalog keys of the capabilities that survived (Tier 0 to 2, known). The database re-checks every tier. */
  capabilities: string[];
  /** Target skill names (a skill that exists now, or one this plan creates). */
  skills: string[];
  /** Set: the agent is created and then archived (disabled). Only ever on `create`. */
  disabled_reason: ImportDisabledReason | null;
}

export interface ImportPlanSkill {
  name: string;
  /** `new_version`: the skill exists and the body changed; the database appends a version, it never rewrites one. */
  action: "create" | "new_version";
  body: string;
}

export interface ImportPlan {
  rule: ConflictRule;
  agents: ImportPlanAgent[];
  skills: ImportPlanSkill[];
}

export interface ImportOutcome {
  /** The report: what the dry run shows, and what the apply returns with its counts. */
  preview: ImportPreview;
  /** Empty when the preview is not importable (a blocker) or there is nothing to write. */
  plan: ImportPlan;
}

/** The report and the plan for a validated pack. Pure: the caller supplies the workspace state. */
export function buildImportPlan(pack: AgentPack, context: PreviewContext): ImportOutcome {
  const rule = context.conflictRule ?? "new_version";
  const { preview, agentTargets, skillTargets } = buildImportOutcome(pack, context);
  const plan: ImportPlan = { rule, agents: [], skills: [] };
  if (!preview.importable) return { preview, plan };

  const skillTargetByName = new Map(
    pack.skills.map((skill, index) => [skill.name, skillTargets[index] ?? skill.name] as const),
  );

  pack.skills.forEach((skill, index) => {
    const entry = preview.skills[index];
    if (!entry || entry.action === "skip") return;
    plan.skills.push({
      name: skillTargets[index] ?? skill.name,
      action: entry.action === "update" ? "new_version" : "create",
      body: skill.body,
    });
  });

  pack.agents.forEach((agent, index) => {
    const entry = preview.agents[index];
    if (!entry || entry.action === "skip") return;
    const capabilityKeys = agent.capabilities
      .filter((_, position) => entry.capabilities[position]?.status === "applied")
      .map((capability) => capability.name);
    plan.agents.push({
      name: agentTargets[index] ?? agent.name,
      action: entry.action,
      role: agent.role,
      model: agent.model,
      thinking_effort: agent.thinkingEffort,
      prompt: agent.prompt,
      daily_budget_cents: entry.appliedBudgetCents,
      capabilities: capabilityKeys,
      skills: [...new Set(agent.skills.map((name) => skillTargetByName.get(name) ?? name))],
      // A new agent is archived on a trifecta, and so is an updated one whose existing plus imported capabilities
      // complete the trifecta (the function checks again from its own tables).
      disabled_reason: entry.importDisabled?.reason ?? null,
    });
  });
  return { preview, plan };
}
