import { z } from "zod";

import { POLICY_AGENT_MODES, type PolicyAgentMode } from "../policy/policy-engine.js";

/**
 * Agent mode: the autonomy dial's setting for one agent (AGO-43), and how it changes (AGO-99).
 *
 * Every new agent starts in Strict. The database is the source of truth: the wizard, a template, a duplicate and,
 * later, a pack import (AGO-194) send no mode, the `agents.mode` column default is `strict`, and the insert guard
 * refuses any other mode for a new row. `NEW_AGENT_MODE` in `agent-limits.ts` is the one name for that value in
 * code; nothing sends it. Only a signed-in workspace owner can change a mode afterwards (promotion, or demotion
 * back towards Strict); an agent can never change its own mode.
 */
export const AGENT_MODES = POLICY_AGENT_MODES;
export type AgentMode = PolicyAgentMode;

export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  strict: "Strict",
  standard: "Standard",
  relaxed: "Relaxed",
};

/** What each mode means for the owner deciding. Tier 3 and 4 actions need a person in every mode. */
export const AGENT_MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  strict: "Every action that changes something waits for your approval.",
  standard: "Actions follow the agent's grants and your policies.",
  relaxed:
    "The agent can edit its own notes without asking (you can revert each edit). Everything else follows its grants.",
};

export const AGENT_MODE_MESSAGES = {
  modeRequired: "Pick a mode.",
  modeUnknown: "Pick one of the listed modes.",
  confirmRequired: "Confirm that you reviewed this agent's work and want to change its mode.",
} as const;

export const agentModeSchema = z.enum(AGENT_MODES, {
  error: (issue) =>
    issue.input === undefined || issue.input === ""
      ? AGENT_MODE_MESSAGES.modeRequired
      : AGENT_MODE_MESSAGES.modeUnknown,
});

/**
 * Change an agent's mode. The caller must tick the confirm box (`on`, as a form sends it). There is no field
 * for who changes it or when: the database stamps those from the signed-in member.
 */
export const setAgentModeSchema = z.strictObject({
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  mode: agentModeSchema,
  confirm: z.literal("on", { error: AGENT_MODE_MESSAGES.confirmRequired }),
});
export type SetAgentModeInput = z.infer<typeof setAgentModeSchema>;

/** One row of the mode change log (`agent_mode_changes`). */
export interface AgentModeChange {
  fromMode: AgentMode;
  toMode: AgentMode;
  changedByName: string | null;
  createdAt: string;
}
