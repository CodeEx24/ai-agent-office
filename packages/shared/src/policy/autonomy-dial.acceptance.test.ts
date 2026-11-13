import { describe, expect, it } from "vitest";

import type { CapabilityTier } from "../capabilities/capability-schemas.js";

import {
  evaluatePolicy,
  parsePolicyAgentMode,
  type PolicyAgentMode,
  type PolicyEngineInput,
  type PolicyEngineLayer,
} from "./policy-engine.js";

// Independent acceptance tests for AGO-43. Expected values come from the ticket AC, not from the engine.
const OWN = "vault.write_own";
const TIER2_OTHERS = ["vault.write_shared", "vault.delete", "web.fetch_write", "x.unknown_tier2"];

function build(
  mode: string,
  key: string,
  opts: {
    callTier?: CapabilityTier;
    grantTier?: CapabilityTier;
    grantMode?: "automatic" | "approval";
    isEnabled?: boolean;
    policies?: readonly PolicyEngineLayer[];
    toolName?: string;
  } = {},
): PolicyEngineInput {
  const callTier = opts.callTier ?? 2;
  return {
    call: { toolName: opts.toolName ?? "t", capabilityKey: key, tier: callTier, isBuiltin: false },
    agent: {
      // Deliberately cast: a stored value can be anything; the engine itself must fail closed.
      mode: mode as PolicyAgentMode,
      grants: [
        {
          capabilityKey: key,
          tier: opts.grantTier ?? callTier,
          mode: opts.grantMode ?? "approval",
          isEnabled: opts.isEnabled ?? true,
        },
      ],
    },
    policies: opts.policies ?? [],
  };
}

function rulesLayer(
  level: PolicyEngineLayer["level"],
  effect: "allow" | "deny" | "require_approval",
  action: string,
): PolicyEngineLayer {
  return { id: `${level}-${effect}`, level, rule: { version: 1, rules: [{ action, effect }] } };
}

describe("AC1: Relaxed auto-runs only own-notes edits", () => {
  it("allows vault.write_own in relaxed with an approval-mode grant and names the own-notes reason", () => {
    expect(evaluatePolicy(build("relaxed", OWN))).toEqual({
      decision: "allow",
      reasonCode: "allowed_tier2_own_notes",
    });
  });

  it.each(TIER2_OTHERS)("escalates %s in relaxed when its grant needs approval", (key) => {
    expect(evaluatePolicy(build("relaxed", key))).toMatchObject({
      decision: "escalate",
      reasonCode: "grant_requires_approval",
    });
  });

  it.each(["strict", "standard"])(
    "escalates vault.write_own in %s with an approval grant",
    (mode) => {
      expect(evaluatePolicy(build(mode, OWN)).decision).toBe("escalate");
    },
  );

  it("does not match a look-alike capability key such as vault.write_own2", () => {
    for (const key of [
      "vault.write_own2",
      "vault.write_owner",
      "Vault.write_own",
      "vault.write_own ",
    ]) {
      expect(evaluatePolicy(build("relaxed", key)).decision, key).toBe("escalate");
    }
  });

  it("does not allow own-notes by tool name alone when the capability key is different", () => {
    const result = evaluatePolicy(build("relaxed", "vault.write_shared", { toolName: OWN }));
    expect(result.decision).toBe("escalate");
  });

  it("denies vault.write_own when the capability is disabled, even in relaxed", () => {
    expect(evaluatePolicy(build("relaxed", OWN, { isEnabled: false }))).toMatchObject({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });

  it("denies vault.write_own in relaxed when the agent has no grant for it", () => {
    const base = build("relaxed", OWN);
    const noGrant: PolicyEngineInput = { ...base, agent: { mode: "relaxed", grants: [] } };
    expect(evaluatePolicy(noGrant)).toMatchObject({ decision: "deny", reasonCode: "not_granted" });
  });

  it("denies vault.write_own in relaxed when a stored policy is unparsable", () => {
    const broken: PolicyEngineLayer = { id: "bad", level: "agent", rule: null };
    expect(evaluatePolicy(build("relaxed", OWN, { policies: [broken] })).decision).toBe("deny");
  });

  it.each(["baseline", "team", "agent"] as const)(
    "a %s-level deny rule beats the own-notes allowance",
    (level) => {
      const result = evaluatePolicy(
        build("relaxed", OWN, { policies: [rulesLayer(level, "deny", "vault.*")] }),
      );
      expect(result).toMatchObject({ decision: "deny", reasonCode: "deny_rule" });
    },
  );

  it("a deny rule matched by tool name beats the own-notes allowance", () => {
    const result = evaluatePolicy(
      build("relaxed", OWN, {
        toolName: "write_note",
        policies: [rulesLayer("agent", "deny", "write_note")],
      }),
    );
    expect(result.decision).toBe("deny");
  });

  it("a deny rule beats an allow rule on the same call in relaxed", () => {
    const result = evaluatePolicy(
      build("relaxed", OWN, {
        policies: [rulesLayer("agent", "allow", "*"), rulesLayer("baseline", "deny", OWN)],
      }),
    );
    expect(result.decision).toBe("deny");
  });

  it("a require_approval rule at any level still escalates own-notes in relaxed", () => {
    for (const level of ["baseline", "team", "agent"] as const) {
      const result = evaluatePolicy(
        build("relaxed", OWN, { policies: [rulesLayer(level, "require_approval", "*")] }),
      );
      expect(result, level).toMatchObject({
        decision: "escalate",
        reasonCode: "rule_requires_approval",
      });
    }
  });

  it("an allow rule does not change a strict escalation of own-notes", () => {
    const result = evaluatePolicy(
      build("strict", OWN, { policies: [rulesLayer("agent", "allow", "*")] }),
    );
    expect(result.decision).toBe("escalate");
  });

  it("a grant raised to tier 3 on vault.write_own escalates in relaxed", () => {
    const result = evaluatePolicy(build("relaxed", OWN, { grantTier: 3 }));
    expect(result).toMatchObject({ decision: "escalate", reasonCode: "tier_requires_approval" });
  });

  it("a tier 1 approval grant on vault.write_own is not the own-notes path and escalates", () => {
    const result = evaluatePolicy(build("relaxed", OWN, { callTier: 1, grantTier: 1 }));
    expect(result).toMatchObject({ decision: "escalate", reasonCode: "grant_requires_approval" });
  });
});

describe("AC1: Strict and Standard are unchanged", () => {
  const tier2 = (mode: string, grantMode: "automatic" | "approval") =>
    evaluatePolicy(build(mode, "vault.write_shared", { grantMode }));

  it("strict escalates tier 2 with an automatic grant", () => {
    expect(tier2("strict", "automatic")).toMatchObject({
      decision: "escalate",
      reasonCode: "strict_mode_tier2",
    });
  });

  it("standard allows tier 2 with an automatic grant", () => {
    expect(tier2("standard", "automatic")).toMatchObject({
      decision: "allow",
      reasonCode: "allowed_tier2",
    });
  });

  it.each(["strict", "standard"])("%s escalates tier 2 with an approval grant", (mode) => {
    expect(tier2(mode, "approval")).toMatchObject({
      decision: "escalate",
      reasonCode: "grant_requires_approval",
    });
  });

  it.each(["strict", "standard", "relaxed"])(
    "%s allows tier 0 and tier 1 automatic grants",
    (mode) => {
      expect(
        evaluatePolicy(build(mode, "vault.read", { callTier: 0, grantMode: "automatic" })),
      ).toMatchObject({ decision: "allow", reasonCode: "allowed_tier0" });
      expect(
        evaluatePolicy(build(mode, "vault.read", { callTier: 1, grantMode: "automatic" })),
      ).toMatchObject({ decision: "allow", reasonCode: "allowed_tier1" });
    },
  );

  it("is deterministic: the same relaxed input gives the same answer twice", () => {
    const i = build("relaxed", OWN);
    expect(evaluatePolicy(i)).toEqual(evaluatePolicy(i));
  });
});

describe("AC2: Tier 3 and 4 escalate in every mode and cannot be loosened", () => {
  const storedModes = [
    "strict",
    "standard",
    "relaxed",
    "RELAXED",
    "Relaxed ",
    "unknown",
    "",
    "admin",
    "yolo",
  ];
  const policySets = [
    [],
    [rulesLayer("agent", "allow", "*")],
    [rulesLayer("team", "allow", "code.*")],
    [rulesLayer("baseline", "allow", "code.run"), rulesLayer("agent", "allow", "*")],
  ];

  it("never allows a tier 3 or tier 4 call whatever the stored mode, grant mode or allow rules", () => {
    for (const stored of storedModes) {
      for (const tier of [3, 4] as const) {
        for (const grantMode of ["automatic", "approval"] as const) {
          for (const policies of policySets) {
            // Both the raw value (engine must fail closed itself) and the parsed value.
            for (const mode of [stored, parsePolicyAgentMode(stored)]) {
              const result = evaluatePolicy(
                build(mode, "code.run", { callTier: tier, grantMode, policies }),
              );
              expect(result, `${stored}/${mode}/t${String(tier)}/${grantMode}`).toEqual({
                decision: "escalate",
                reasonCode: "tier_requires_approval",
              });
            }
          }
        }
      }
    }
  });

  it("escalates a tier 3 or 4 own-notes capability in relaxed (the allowance is tier 2 only)", () => {
    for (const tier of [3, 4] as const) {
      expect(evaluatePolicy(build("relaxed", OWN, { callTier: tier })).decision).toBe("escalate");
    }
  });

  it("a mislabelled tool tier (0 to 2) cannot lower a tier 4 grant in any mode", () => {
    for (const mode of ["strict", "standard", "relaxed"]) {
      for (const callTier of [0, 1, 2] as const) {
        const result = evaluatePolicy(
          build(mode, "payments.send", {
            callTier,
            grantTier: 4,
            grantMode: "automatic",
            policies: [rulesLayer("agent", "allow", "*")],
          }),
        );
        expect(result.reasonCode, `${mode}/${String(callTier)}`).toBe("tier_requires_approval");
      }
    }
  });

  it("a mislabelled grant tier (0) cannot lower a tier 4 tool in any mode", () => {
    for (const mode of ["strict", "standard", "relaxed"]) {
      const result = evaluatePolicy(
        build(mode, "payments.send", { callTier: 4, grantTier: 0, grantMode: "automatic" }),
      );
      expect(result.decision, mode).toBe("escalate");
    }
  });

  it("a deny rule still denies tier 4 in every mode (deny wins over escalate)", () => {
    for (const mode of ["strict", "standard", "relaxed"]) {
      const result = evaluatePolicy(
        build(mode, "payments.send", {
          callTier: 4,
          policies: [rulesLayer("baseline", "deny", "payments.*")],
        }),
      );
      expect(result.decision, mode).toBe("deny");
    }
  });

  it("an out-of-range or fractional tier is rejected, never allowed", () => {
    for (const bad of [5, -1, 2.5, Number.NaN]) {
      const result = evaluatePolicy(build("relaxed", OWN, { callTier: bad as CapabilityTier }));
      expect(result.decision, String(bad)).toBe("deny");
    }
    const badGrant = evaluatePolicy(build("relaxed", OWN, { grantTier: 9 as CapabilityTier }));
    expect(badGrant.decision).toBe("deny");
  });

  it("a tier 3 or 4 call with no catalog capability is denied even with an allow rule", () => {
    for (const tier of [3, 4] as const) {
      const result = evaluatePolicy({
        call: { toolName: "t", capabilityKey: null, tier, isBuiltin: true },
        agent: { mode: "relaxed", grants: [] },
        policies: [rulesLayer("agent", "allow", "*")],
      });
      expect(result.decision).toBe("deny");
    }
  });
});

describe("AC1/AC2: unknown mode fails closed to strict", () => {
  it.each([
    "",
    "Strict",
    "STANDARD",
    "relaxed ",
    " relaxed",
    "relaxed\n",
    "autonomous",
    "null",
    "0",
  ])("parses %j to strict", (value) => {
    expect(parsePolicyAgentMode(value)).toBe("strict");
  });

  it("parses the three known modes to themselves", () => {
    expect(["strict", "standard", "relaxed"].map(parsePolicyAgentMode)).toEqual([
      "strict",
      "standard",
      "relaxed",
    ]);
  });

  it("engine treats an unrecognised raw mode as strict for tier 2 and own-notes", () => {
    expect(
      evaluatePolicy(build("autonomous", "vault.write_shared", { grantMode: "automatic" })),
    ).toMatchObject({ decision: "escalate", reasonCode: "strict_mode_tier2" });
    expect(evaluatePolicy(build("autonomous", OWN)).decision).toBe("escalate");
  });

  it("a parsed look-alike mode never reaches the own-notes allowance", () => {
    expect(evaluatePolicy(build(parsePolicyAgentMode("Relaxed"), OWN)).decision).toBe("escalate");
  });
});
