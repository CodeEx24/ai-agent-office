import { describe, expect, it } from "vitest";

import { CAPABILITY_TIERS, type CapabilityTier } from "../capabilities/capability-schemas.js";

import {
  evaluatePolicy,
  OWN_NOTES_CAPABILITY,
  parsePolicyAgentMode,
  POLICY_AGENT_MODES,
  type PolicyAgentMode,
  type PolicyEngineInput,
  type PolicyEngineLayer,
} from "./policy-engine.js";

function input(
  tier: CapabilityTier,
  mode: PolicyAgentMode,
  grantMode: "automatic" | "approval",
  key: string,
  policies: readonly PolicyEngineLayer[] = [],
): PolicyEngineInput {
  return {
    call: { toolName: "tool", capabilityKey: key, tier, isBuiltin: false },
    agent: { mode, grants: [{ capabilityKey: key, tier, mode: grantMode, isEnabled: true }] },
    policies,
  };
}

const allowAll: PolicyEngineLayer = {
  id: "p-allow",
  level: "agent",
  rule: { version: 1, rules: [{ action: "*", effect: "allow" }] },
};

describe("autonomy dial: Relaxed mode (AC1)", () => {
  it("auto-runs own-notes edits in relaxed even with an approval-mode grant", () => {
    expect(evaluatePolicy(input(2, "relaxed", "approval", OWN_NOTES_CAPABILITY))).toMatchObject({
      decision: "allow",
      reasonCode: "allowed_tier2_own_notes",
    });
  });

  it("does not do that in strict or standard", () => {
    expect(evaluatePolicy(input(2, "strict", "approval", OWN_NOTES_CAPABILITY))).toMatchObject({
      decision: "escalate",
    });
    expect(evaluatePolicy(input(2, "standard", "approval", OWN_NOTES_CAPABILITY))).toMatchObject({
      decision: "escalate",
      reasonCode: "grant_requires_approval",
    });
  });

  it("does not extend to other Tier 2 capabilities with an approval grant", () => {
    expect(evaluatePolicy(input(2, "relaxed", "approval", "vault.write_shared"))).toMatchObject({
      decision: "escalate",
      reasonCode: "grant_requires_approval",
    });
  });

  it("a deny or require_approval rule still wins over the own-notes allowance", () => {
    const deny: PolicyEngineLayer = {
      id: "d",
      level: "baseline",
      rule: { version: 1, rules: [{ action: OWN_NOTES_CAPABILITY, effect: "deny" }] },
    };
    const approval: PolicyEngineLayer = {
      id: "a",
      level: "baseline",
      rule: { version: 1, rules: [{ action: OWN_NOTES_CAPABILITY, effect: "require_approval" }] },
    };
    expect(
      evaluatePolicy(input(2, "relaxed", "approval", OWN_NOTES_CAPABILITY, [deny])).decision,
    ).toBe("deny");
    expect(
      evaluatePolicy(input(2, "relaxed", "approval", OWN_NOTES_CAPABILITY, [approval])).decision,
    ).toBe("escalate");
  });

  it("Tier 2 in relaxed with an automatic grant is allowed like standard", () => {
    expect(evaluatePolicy(input(2, "relaxed", "automatic", "vault.write_shared")).decision).toBe(
      "allow",
    );
  });

  it("parses relaxed and still maps unknown values to strict", () => {
    expect(parsePolicyAgentMode("relaxed")).toBe("relaxed");
    expect(parsePolicyAgentMode("RELAXED")).toBe("strict");
    expect(parsePolicyAgentMode("anything")).toBe("strict");
  });
});

describe("autonomy dial: Tier 3 and 4 cannot be loosened (AC2)", () => {
  const modes = [...POLICY_AGENT_MODES, "unknown-mode", ""] as const;
  const grantModes = ["automatic", "approval"] as const;
  const keys = [OWN_NOTES_CAPABILITY, "vault.write_shared", "code.run", "x.unknown"];
  const highTiers = CAPABILITY_TIERS.filter((tier) => tier >= 3);

  it("never returns allow for tier 3 or 4 in any mode, grant mode, capability or allow rule", () => {
    let checked = 0;
    for (const rawMode of modes) {
      const mode = parsePolicyAgentMode(rawMode);
      for (const tier of highTiers) {
        for (const grantMode of grantModes) {
          for (const key of keys) {
            for (const policies of [[], [allowAll]]) {
              const result = evaluatePolicy(input(tier, mode, grantMode, key, policies));
              expect(result.decision, `${rawMode}/${String(tier)}/${grantMode}/${key}`).toBe(
                "escalate",
              );
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a mislabelled lower tool tier cannot lower a Tier 4 grant in relaxed mode", () => {
    const result = evaluatePolicy({
      call: { toolName: "t", capabilityKey: OWN_NOTES_CAPABILITY, tier: 2, isBuiltin: false },
      agent: {
        mode: "relaxed",
        grants: [
          { capabilityKey: OWN_NOTES_CAPABILITY, tier: 4, mode: "approval", isEnabled: true },
        ],
      },
      policies: [allowAll],
    });
    expect(result).toMatchObject({ decision: "escalate", reasonCode: "tier_requires_approval" });
  });
});
