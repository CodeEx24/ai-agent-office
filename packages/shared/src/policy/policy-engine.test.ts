import { describe, expect, it } from "vitest";

import { CAPABILITY_TIERS, type CapabilityTier } from "../capabilities/capability-schemas.js";

import {
  evaluatePolicy,
  matchesPolicyAction,
  parsePolicyAgentMode,
  POLICY_AGENT_MODES,
  type PolicyAgentMode,
  type PolicyEngineInput,
  type PolicyEngineLayer,
} from "./policy-engine.js";
import { POLICY_LEVELS, type PolicyLevel } from "./policy-schemas.js";

const KEY = "vault.read";

const layer = (
  level: PolicyLevel,
  effect: "allow" | "require_approval" | "deny",
  action = KEY,
  id = `${level}-policy`,
): PolicyEngineLayer => ({ id, level, rule: { version: 1, rules: [{ action, effect }] } });

function input(
  tier: CapabilityTier,
  over: {
    mode?: PolicyAgentMode;
    grantMode?: "automatic" | "approval";
    granted?: boolean;
    enabled?: boolean;
    policies?: readonly PolicyEngineLayer[];
  } = {},
): PolicyEngineInput {
  const granted = over.granted ?? true;
  return {
    call: { toolName: "some_tool", capabilityKey: KEY, tier, isBuiltin: false },
    agent: {
      mode: over.mode ?? "strict",
      grants: granted
        ? [
            {
              capabilityKey: KEY,
              tier,
              mode: over.grantMode ?? "automatic",
              isEnabled: over.enabled ?? true,
            },
          ]
        : [],
    },
    policies: over.policies ?? [],
  };
}

describe("tier defaults x agent mode (no policies, automatic grant)", () => {
  const table: readonly [CapabilityTier, PolicyAgentMode, string, string][] = [
    [0, "strict", "allow", "allowed_tier0"],
    [0, "standard", "allow", "allowed_tier0"],
    [1, "strict", "allow", "allowed_tier1"],
    [1, "standard", "allow", "allowed_tier1"],
    [2, "strict", "escalate", "strict_mode_tier2"],
    [2, "standard", "allow", "allowed_tier2"],
    [3, "strict", "escalate", "tier_requires_approval"],
    [3, "standard", "escalate", "tier_requires_approval"],
    [4, "strict", "escalate", "tier_requires_approval"],
    [4, "standard", "escalate", "tier_requires_approval"],
    [0, "relaxed", "allow", "allowed_tier0"],
    [1, "relaxed", "allow", "allowed_tier1"],
    [2, "relaxed", "allow", "allowed_tier2"],
    [3, "relaxed", "escalate", "tier_requires_approval"],
    [4, "relaxed", "escalate", "tier_requires_approval"],
  ];
  it.each(table)("tier %i, %s mode -> %s (%s)", (tier, mode, decision, reasonCode) => {
    expect(evaluatePolicy(input(tier, { mode }))).toEqual({ decision, reasonCode });
  });

  it("covers every tier 0-4 and every mode", () => {
    for (const tier of CAPABILITY_TIERS) {
      for (const mode of POLICY_AGENT_MODES) {
        expect(table.some(([t, m]) => t === tier && m === mode)).toBe(true);
      }
    }
  });
});

describe("AC1: a Tier 3 call escalates", () => {
  it("escalates in every mode, even with an automatic grant and an explicit allow rule", () => {
    for (const mode of POLICY_AGENT_MODES) {
      for (const level of POLICY_LEVELS) {
        const result = evaluatePolicy(input(3, { mode, policies: [layer(level, "allow")] }));
        expect(result.decision).toBe("escalate");
      }
    }
  });

  it("uses the grant's tier when the tool claims a lower one", () => {
    const base = input(3);
    const result = evaluatePolicy({ ...base, call: { ...base.call, tier: 0 } });
    expect(result).toEqual({ decision: "escalate", reasonCode: "tier_requires_approval" });
  });
});

describe("AC2: deny at any level is deny", () => {
  it.each(POLICY_LEVELS)("a %s deny rule denies tiers 0-4 in every mode", (level) => {
    for (const tier of CAPABILITY_TIERS) {
      for (const mode of POLICY_AGENT_MODES) {
        const result = evaluatePolicy(input(tier, { mode, policies: [layer(level, "deny")] }));
        expect(result.decision).toBe("deny");
        expect(result.reasonCode).toBe("deny_rule");
        expect(result.ruleId).toBe(`${level}-policy:0`);
      }
    }
  });

  it("a more specific allow or require_approval never loosens a deny from another level", () => {
    for (const denyLevel of POLICY_LEVELS) {
      for (const other of POLICY_LEVELS) {
        for (const effect of ["allow", "require_approval"] as const) {
          if (other === denyLevel) continue;
          const policies = [layer(denyLevel, "deny"), layer(other, effect, KEY, "other")];
          expect(evaluatePolicy(input(1, { policies })).decision).toBe("deny");
        }
      }
    }
  });

  it("deny is reported even at tier 4", () => {
    expect(evaluatePolicy(input(4, { policies: [layer("baseline", "deny")] })).decision).toBe(
      "deny",
    );
  });

  it("matches on the tool name and on wildcards", () => {
    const denied = (action: string): string =>
      evaluatePolicy(input(0, { policies: [layer("agent", "deny", action)] })).decision;
    expect(denied("some_tool")).toBe("deny");
    expect(denied("vault.*")).toBe("deny");
    expect(denied("*")).toBe("deny");
    expect(denied("web.*")).toBe("allow");
  });
});

describe("grants", () => {
  it("denies an ungranted capability", () => {
    expect(evaluatePolicy(input(0, { granted: false }))).toEqual({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });
  it("denies a disabled capability", () => {
    expect(evaluatePolicy(input(0, { enabled: false })).reasonCode).toBe("not_granted");
  });
  it("escalates when the grant is approval-mode, even at tier 1 in standard mode", () => {
    expect(evaluatePolicy(input(1, { mode: "standard", grantMode: "approval" }))).toEqual({
      decision: "escalate",
      reasonCode: "grant_requires_approval",
    });
  });
  it("denies a tool with no catalog capability unless it is a tier-0 built-in", () => {
    const base = input(0);
    const call = { ...base.call, capabilityKey: null };
    expect(evaluatePolicy({ ...base, call }).reasonCode).toBe("no_capability");
    expect(evaluatePolicy({ ...base, call: { ...call, isBuiltin: true } })).toEqual({
      decision: "allow",
      reasonCode: "allowed_tier0",
    });
    expect(evaluatePolicy({ ...base, call: { ...call, isBuiltin: true, tier: 1 } }).decision).toBe(
      "deny",
    );
  });
  it("a deny rule on a built-in's tool name still denies it", () => {
    const base = input(0, { policies: [layer("baseline", "deny", "get_current_time")] });
    const call = {
      toolName: "get_current_time",
      capabilityKey: null,
      tier: 0 as const,
      isBuiltin: true,
    };
    expect(evaluatePolicy({ ...base, call }).decision).toBe("deny");
  });
});

describe("rules and fail-closed behaviour", () => {
  it("a require_approval rule escalates tiers 0-2 and reports the rule", () => {
    for (const tier of [0, 1, 2] as const) {
      const result = evaluatePolicy(
        input(tier, { mode: "standard", policies: [layer("department", "require_approval")] }),
      );
      expect(result).toEqual({
        decision: "escalate",
        reasonCode: "rule_requires_approval",
        ruleId: "department-policy:0",
      });
    }
  });
  it("an allow rule never loosens strict mode at tier 2", () => {
    expect(evaluatePolicy(input(2, { policies: [layer("agent", "allow")] })).decision).toBe(
      "escalate",
    );
  });
  it("denies when any stored policy failed to parse", () => {
    const broken: PolicyEngineLayer = { id: "bad", level: "agent", rule: null };
    expect(evaluatePolicy(input(0, { policies: [broken] }))).toEqual({
      decision: "deny",
      reasonCode: "policy_invalid",
    });
  });
  it("treats an unknown stored mode as strict", () => {
    expect(parsePolicyAgentMode("autonomous")).toBe("strict");
    expect(parsePolicyAgentMode("standard")).toBe("standard");
    expect(parsePolicyAgentMode("")).toBe("strict");
  });
  it("denies an out-of-range tier", () => {
    const base = input(0);
    const call = { ...base.call, tier: 7 as unknown as CapabilityTier };
    expect(evaluatePolicy({ ...base, call }).decision).toBe("deny");
  });
  it("is deterministic and does not depend on the order of policies", () => {
    const policies = [layer("agent", "deny", KEY, "z"), layer("baseline", "deny", KEY, "a")];
    const forward = evaluatePolicy(input(1, { policies }));
    const backward = evaluatePolicy(input(1, { policies: [...policies].reverse() }));
    expect(forward).toEqual(backward);
    expect(forward).toEqual(evaluatePolicy(input(1, { policies })));
  });
});

describe("matchesPolicyAction", () => {
  it.each([
    ["*", "anything", true],
    ["vault.*", "vault.read", true],
    ["vault.*", "vault", false],
    ["vault.*", "vaultx.read", false],
    ["vault.read", "vault.read", true],
    ["vault.read", "vault.read_private", false],
    ["Vault.read", "vault.read", false],
  ])("%s vs %s -> %s", (action, target, expected) => {
    expect(matchesPolicyAction(action, target)).toBe(expected);
  });
});

describe("property: adding a deny never turns a deny into an allow", () => {
  // A small deterministic generator, so a failure reproduces.
  function lcg(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }
  const pick = <T>(random: () => number, items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;

  it("holds for 2000 random inputs, and adding a matching deny always yields deny", () => {
    const random = lcg(34);
    const actions = [KEY, "some_tool", "vault.*", "*", "web.search", "other.key"];
    for (let i = 0; i < 2000; i += 1) {
      const policies: PolicyEngineLayer[] = [];
      const count = Math.floor(random() * 5);
      for (let n = 0; n < count; n += 1) {
        policies.push(
          layer(
            pick(random, POLICY_LEVELS),
            pick(random, ["allow", "require_approval", "deny"] as const),
            pick(random, actions),
            `p${String(n)}`,
          ),
        );
      }
      const base = input(pick(random, CAPABILITY_TIERS), {
        mode: pick(random, POLICY_AGENT_MODES),
        grantMode: pick(random, ["automatic", "approval"] as const),
        granted: random() > 0.2,
        enabled: random() > 0.1,
        policies,
      });
      const before = evaluatePolicy(base);
      const extra = layer(
        pick(random, POLICY_LEVELS),
        "deny",
        pick(random, [KEY, "some_tool"]),
        "extra",
      );
      const after = evaluatePolicy({ ...base, policies: [...policies, extra] });
      if (before.decision === "deny") expect(after.decision).toBe("deny");
      expect(after.decision).toBe("deny");
      // Tier 3 and 4 are never an allow, whatever the policies say.
      if (base.call.tier >= 3) expect(before.decision).not.toBe("allow");
    }
  });
});
