import {
  MIN_NEVER_AUTOMATIC_TIER,
  type CapabilityTier,
} from "../capabilities/capability-schemas.js";

import { POLICY_LEVELS, type PolicyLevel, type PolicyRule } from "./policy-schemas.js";

/**
 * The deterministic policy engine (AGO-34). A pure function: the same input always gives the same
 * answer, it reads nothing (no clock, no database, no model) and it never throws on valid input.
 * The worker loads the input from the database (policies, grants, agent mode) and calls `evaluatePolicy`
 * before every tool call.
 *
 * Decision order, first match wins:
 *  1. a stored policy failed to parse (cannot be trusted)           -> deny  `policy_invalid`
 *  2. the tool has no catalog capability and is not a built-in      -> deny  `no_capability`
 *  3. the agent has no grant, or the capability is disabled         -> deny  `not_granted`
 *  4. ANY deny rule at ANY level matches                            -> deny  `deny_rule`
 *  5. effective tier is 3 or 4                                      -> escalate `tier_requires_approval`
 *  6. a require_approval rule matches                               -> escalate `rule_requires_approval`
 *  7. the grant runs in `approval` mode                             -> escalate `grant_requires_approval`
 *  8. tier 2 and the agent is in strict mode (or an unknown mode)   -> escalate `strict_mode_tier2`
 *  9. otherwise (tier 0 and 1, or tier 2 in a looser mode)          -> allow
 *
 * Why it is safe:
 * - Deny wins: step 4 is before every step that can allow, so no layer can turn a deny into an allow, and
 *   adding a rule never removes a deny.
 * - Layers only tighten: `allow` rules never loosen anything in v1. Tier 3 and 4 can never be `allow`: there is
 *   no code path that returns allow at that tier. The effective tier is the highest of the tool's tier and
 *   the grant's tier, so a mislabelled tool cannot lower it.
 * - Fail closed: an unknown tier, an unknown agent mode and an unparsable policy all resolve to the
 *   stricter answer.
 */

export const POLICY_DECISIONS = ["allow", "deny", "escalate"] as const;
export type PolicyEngineDecision = (typeof POLICY_DECISIONS)[number];

/** Fixed reason codes. Never free text, so a decision carries no tool arguments and no secrets. */
export const POLICY_REASON_CODES = [
  "policy_invalid",
  "no_capability",
  "not_granted",
  "deny_rule",
  "tier_requires_approval",
  "rule_requires_approval",
  "grant_requires_approval",
  "strict_mode_tier2",
  "allowed_tier0",
  "allowed_tier1",
  "allowed_tier2",
] as const;
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** Agent modes. `strict` is the default for every agent; an unknown stored value is treated as strict. */
export const POLICY_AGENT_MODES = ["strict", "standard"] as const;
export type PolicyAgentMode = (typeof POLICY_AGENT_MODES)[number];

export function parsePolicyAgentMode(value: string): PolicyAgentMode {
  return value === "standard" ? "standard" : "strict";
}

export interface PolicyEngineCall {
  /** The registered tool's name. Rules may match on it as well as on the capability key. */
  readonly toolName: string;
  /** Catalog key such as `vault.read`, or null when the tool has no catalog capability. */
  readonly capabilityKey: string | null;
  /** The tool's own tier (AGO-125 catalog). */
  readonly tier: CapabilityTier;
  /** True for a built-in, side-effect free tier-0 tool that needs no grant (e.g. `get_current_time`). */
  readonly isBuiltin: boolean;
  /** A short summary of the arguments, for the audit trail. Rules do not match on it in v1. */
  readonly argsSummary?: string;
}

export interface PolicyEngineGrant {
  readonly capabilityKey: string;
  /** Tier stored on the grant / catalog row. */
  readonly tier: CapabilityTier;
  readonly mode: "automatic" | "approval";
  /** False when the catalog capability is disabled or missing. A disabled capability is never granted. */
  readonly isEnabled: boolean;
}

export interface PolicyEngineAgent {
  readonly mode: PolicyAgentMode;
  readonly grants: readonly PolicyEngineGrant[];
}

/** One stored policy. `rule` is null when the stored JSON failed `policyRuleSchema`. */
export interface PolicyEngineLayer {
  readonly id: string;
  readonly level: PolicyLevel;
  readonly rule: PolicyRule | null;
}

export interface PolicyEngineInput {
  readonly call: PolicyEngineCall;
  readonly agent: PolicyEngineAgent;
  readonly policies: readonly PolicyEngineLayer[];
}

export interface PolicyEngineResult {
  readonly decision: PolicyEngineDecision;
  readonly reasonCode: PolicyReasonCode;
  /** `<policy id>:<rule index>` of the rule that decided, when one did. */
  readonly ruleId?: string;
}

type RuleEffect = "allow" | "require_approval" | "deny";

const LEVEL_ORDER: Readonly<Record<PolicyLevel, number>> = Object.fromEntries(
  POLICY_LEVELS.map((level, index) => [level, index]),
) as Record<PolicyLevel, number>;

/**
 * A rule's `action` matches a capability key or tool name exactly, as a `prefix.*` wildcard
 * (`vault.*` matches `vault.read`), or as `*` (everything). Case-sensitive.
 */
export function matchesPolicyAction(action: string, target: string): boolean {
  if (action === "*") return true;
  if (action.endsWith(".*")) return target.startsWith(action.slice(0, -1));
  return action === target;
}

function isTier(value: number): value is CapabilityTier {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

/** Rules of every layer that match the call, least specific layer first, in stored order. */
function matchingRules(
  call: PolicyEngineCall,
  policies: readonly PolicyEngineLayer[],
): readonly { readonly effect: RuleEffect; readonly ruleId: string }[] {
  const targets = [call.toolName, ...(call.capabilityKey === null ? [] : [call.capabilityKey])];
  const ordered = [...policies].sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const found: { effect: RuleEffect; ruleId: string }[] = [];
  for (const policy of ordered) {
    if (policy.rule === null) continue;
    policy.rule.rules.forEach((rule, index) => {
      if (targets.some((target) => matchesPolicyAction(rule.action, target))) {
        found.push({ effect: rule.effect, ruleId: `${policy.id}:${String(index)}` });
      }
    });
  }
  return found;
}

export function evaluatePolicy(input: PolicyEngineInput): PolicyEngineResult {
  const { call, agent, policies } = input;

  if (policies.some((policy) => policy.rule === null)) {
    return { decision: "deny", reasonCode: "policy_invalid" };
  }
  if (!isTier(call.tier)) return { decision: "deny", reasonCode: "no_capability" };

  let tier: number = call.tier;
  let grant: PolicyEngineGrant | undefined;
  if (call.capabilityKey === null) {
    // Only a built-in tier-0 tool may run without a catalog capability.
    if (!call.isBuiltin || call.tier !== 0) {
      return { decision: "deny", reasonCode: "no_capability" };
    }
  } else {
    const key = call.capabilityKey;
    grant = agent.grants.find((candidate) => candidate.capabilityKey === key);
    if (!grant?.isEnabled) {
      return { decision: "deny", reasonCode: "not_granted" };
    }
    tier = Math.max(tier, grant.tier);
  }
  if (!isTier(tier)) return { decision: "deny", reasonCode: "no_capability" };

  const rules = matchingRules(call, policies);
  const deny = rules.find((rule) => rule.effect === "deny");
  if (deny !== undefined) return { decision: "deny", reasonCode: "deny_rule", ruleId: deny.ruleId };

  if (tier >= MIN_NEVER_AUTOMATIC_TIER) {
    return { decision: "escalate", reasonCode: "tier_requires_approval" };
  }
  const approval = rules.find((rule) => rule.effect === "require_approval");
  if (approval !== undefined) {
    return { decision: "escalate", reasonCode: "rule_requires_approval", ruleId: approval.ruleId };
  }
  if (grant?.mode === "approval") {
    return { decision: "escalate", reasonCode: "grant_requires_approval" };
  }
  if (tier === 2) {
    return agent.mode === "standard"
      ? { decision: "allow", reasonCode: "allowed_tier2" }
      : { decision: "escalate", reasonCode: "strict_mode_tier2" };
  }
  return { decision: "allow", reasonCode: tier === 0 ? "allowed_tier0" : "allowed_tier1" };
}
