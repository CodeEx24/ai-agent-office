import { evaluatePolicy } from "@ago/shared";

import { DEFAULT_TIER0_ALLOWLIST } from "../agent/policy-hook.js";

import type { PolicySource } from "./pg-policy-source.js";
import type {
  PolicyContext,
  PolicyDecision,
  PolicyHook,
  PolicyToolCall,
} from "../agent/policy-hook.js";
import type { PolicyEngineDecision } from "@ago/shared";

/**
 * The real `PolicyHook` (AGO-34): loads the agent's grants and layered policies from the database and
 * asks the pure engine. It replaces the deny-by-default stub from AGO-167 and keeps its guarantees:
 * - an unregistered tool is denied;
 * - a load error or a throw reaches the loop, which treats it as a deny (`policy_hook_error`), and a hook
 *   that outlives its time budget is a deny (`policy_timeout`);
 * - `escalate` becomes `needs_approval`, which the loop turns into `approval.requested` with a payload
 *   hash and never executes the tool.
 *
 * The decision carries a fixed reason code and a rule id only, never the tool input.
 */

const DECISION_MAP: Readonly<Record<PolicyEngineDecision, PolicyDecision["decision"]>> = {
  allow: "allow",
  deny: "deny",
  escalate: "needs_approval",
};

export function createPolicyEngineHook(deps: {
  readonly source: PolicySource;
  /** Tier-0 tool names that need no grant (no catalog capability, no side effects). */
  readonly builtinTools?: readonly string[];
}): PolicyHook {
  const builtins = new Set(deps.builtinTools ?? DEFAULT_TIER0_ALLOWLIST);
  return {
    async check(call: PolicyToolCall, context: PolicyContext): Promise<PolicyDecision> {
      if (!call.isRegistered) return { decision: "deny", reasonCode: "unknown_tool" };

      const inputs = await deps.source.load({
        workspaceId: context.workspaceId,
        agentId: context.agentId,
      });
      const result = evaluatePolicy({
        call: {
          toolName: call.toolName,
          capabilityKey: call.capabilityKey ?? null,
          tier: call.tier,
          isBuiltin:
            call.capabilityKey === undefined && call.tier === 0 && builtins.has(call.toolName),
        },
        agent: inputs.agent,
        policies: inputs.policies,
      });
      return {
        decision: DECISION_MAP[result.decision],
        reasonCode: result.reasonCode,
        ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
      };
    },
  };
}
