// AGO-34 QA: adversarial checks on the pure policy engine, written by the tester (not the implementer).
// One test per acceptance criterion, plus the attack cases from the QA brief. No I/O.
import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "./policy-engine.js";

import type { CapabilityTier } from "../capabilities/capability-schemas.js";
import type {
  PolicyEngineCall,
  PolicyEngineGrant,
  PolicyEngineInput,
  PolicyEngineLayer,
} from "./policy-engine.js";
import type { PolicyLevel } from "./policy-schemas.js";

const TIERS: readonly CapabilityTier[] = [0, 1, 2, 3, 4];
const LEVELS: readonly PolicyLevel[] = ["baseline", "department", "team", "agent"];

const grant = (over: Partial<PolicyEngineGrant> = {}): PolicyEngineGrant => ({
  capabilityKey: "cap.x",
  tier: 0,
  mode: "automatic",
  isEnabled: true,
  ...over,
});

const layer = (
  level: PolicyLevel,
  effect: "allow" | "deny" | "require_approval",
  action = "cap.x",
  id = `${level}-p`,
): PolicyEngineLayer => ({ id, level, rule: { version: 1, rules: [{ action, effect }] } });

const input = (
  over: {
    tier?: CapabilityTier;
    grantTier?: CapabilityTier;
    mode?: "strict" | "standard";
    grantMode?: "automatic" | "approval";
    policies?: readonly PolicyEngineLayer[];
    call?: Partial<PolicyEngineCall>;
    grants?: readonly PolicyEngineGrant[];
  } = {},
): PolicyEngineInput => ({
  call: {
    toolName: "tool_x",
    capabilityKey: "cap.x",
    tier: over.tier ?? 0,
    isBuiltin: false,
    ...over.call,
  },
  agent: {
    mode: over.mode ?? "strict",
    grants: over.grants ?? [
      grant({ tier: over.grantTier ?? over.tier ?? 0, mode: over.grantMode ?? "automatic" }),
    ],
  },
  policies: over.policies ?? [],
});

describe("AGO-34 QA AC1: a Tier 3 or 4 call escalates", () => {
  it.each([3, 4] as const)("AC1: tier %i escalates in every mode and never allows", (tier) => {
    for (const mode of ["strict", "standard"] as const) {
      for (const grantMode of ["automatic", "approval"] as const) {
        expect(evaluatePolicy(input({ tier, mode, grantMode })).decision).toBe("escalate");
      }
    }
  });

  it("AC1: an allow rule at every level cannot turn a tier 3/4 escalate into an allow", () => {
    for (const tier of [3, 4] as const) {
      const policies = LEVELS.map((level) => layer(level, "allow", "*"));
      expect(evaluatePolicy(input({ tier, mode: "standard", policies }))).toMatchObject({
        decision: "escalate",
        reasonCode: "tier_requires_approval",
      });
    }
  });

  it("AC1: a tool claiming tier 0 on a tier-4 grant still escalates (mislabelled tool)", () => {
    expect(evaluatePolicy(input({ tier: 0, grantTier: 4, mode: "standard" })).decision).toBe(
      "escalate",
    );
  });
});

describe("AGO-34 QA AC2: a deny at any level is a deny", () => {
  it.each(LEVELS)("AC2: a %s deny beats every allow elsewhere, for every tier", (level) => {
    for (const tier of TIERS) {
      const others = LEVELS.filter((l) => l !== level).map((l) =>
        layer(l, "allow", "*", `${l}-allow`),
      );
      const result = evaluatePolicy(
        input({
          tier,
          mode: "standard",
          grantMode: "approval",
          policies: [...others, layer(level, "deny", "cap.*", `${level}-deny`)],
        }),
      );
      expect(result).toMatchObject({ decision: "deny", reasonCode: "deny_rule" });
    }
  });

  it("AC2: deny matches by tool name as well as by capability key", () => {
    expect(evaluatePolicy(input({ policies: [layer("agent", "deny", "tool_x")] })).decision).toBe(
      "deny",
    );
  });

  it("AC2: a deny wins whatever order the layers are supplied in", () => {
    const policies = [
      layer("agent", "allow"),
      layer("department", "require_approval"),
      layer("baseline", "deny"),
    ];
    for (const ordered of [policies, [...policies].reverse()]) {
      expect(evaluatePolicy(input({ policies: ordered })).decision).toBe("deny");
    }
  });

  it("AC2: a deny on a tier 3/4 call is deny, not escalate", () => {
    for (const tier of [3, 4] as const) {
      expect(evaluatePolicy(input({ tier, policies: [layer("baseline", "deny")] })).decision).toBe(
        "deny",
      );
    }
  });

  it("AC2: a deny rule for a different capability does not leak onto this call", () => {
    expect(
      evaluatePolicy(input({ policies: [layer("baseline", "deny", "other.cap")] })).decision,
    ).toBe("allow");
  });
});

describe("AGO-34 QA: ungranted, disabled and unknown capabilities are denied", () => {
  it("denies a capability the agent has no grant for", () => {
    expect(evaluatePolicy(input({ grants: [] }))).toEqual({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });

  it("denies a disabled capability even at tier 0 with an allow rule", () => {
    expect(
      evaluatePolicy(
        input({
          grants: [grant({ isEnabled: false })],
          policies: [layer("agent", "allow", "*")],
        }),
      ).decision,
    ).toBe("deny");
  });

  it("denies a tool with no capability unless it is a tier-0 built-in", () => {
    for (const tier of TIERS) {
      for (const isBuiltin of [false, true]) {
        const result = evaluatePolicy(input({ tier, call: { capabilityKey: null, isBuiltin } }));
        if (isBuiltin && tier === 0) {
          expect(result.decision).toBe("allow");
        } else {
          expect(result).toEqual({ decision: "deny", reasonCode: "no_capability" });
        }
      }
    }
  });

  it("denies an out-of-range or fractional tier instead of treating it as lower", () => {
    for (const tier of [-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        evaluatePolicy(input({ call: { tier: tier as CapabilityTier }, grants: [grant()] }))
          .decision,
      ).toBe("deny");
    }
  });
});

describe("AGO-34 QA: a more specific level cannot loosen", () => {
  it("an agent allow does not loosen a baseline require_approval at tier 1", () => {
    expect(
      evaluatePolicy(
        input({
          tier: 1,
          policies: [layer("baseline", "require_approval"), layer("agent", "allow")],
        }),
      ),
    ).toMatchObject({ decision: "escalate", reasonCode: "rule_requires_approval" });
  });

  it("an agent allow does not loosen strict-mode tier 2 or an approval-mode grant", () => {
    expect(evaluatePolicy(input({ tier: 2, policies: [layer("agent", "allow")] })).decision).toBe(
      "escalate",
    );
    expect(
      evaluatePolicy(input({ tier: 1, grantMode: "approval", policies: [layer("agent", "allow")] }))
        .decision,
    ).toBe("escalate");
  });
});

describe("AGO-34 QA: malformed policy rows fail closed", () => {
  it("a layer with a null (unparsable) rule denies at every level", () => {
    for (const level of LEVELS) {
      expect(evaluatePolicy(input({ policies: [{ id: "bad", level, rule: null }] }))).toEqual({
        decision: "deny",
        reasonCode: "policy_invalid",
      });
    }
  });

  it("a malformed row is checked first, ahead of a missing grant and a built-in", () => {
    expect(
      evaluatePolicy(
        input({
          grants: [],
          call: { capabilityKey: null, isBuiltin: true },
          policies: [{ id: "bad", level: "baseline", rule: null }],
        }),
      ).reasonCode,
    ).toBe("policy_invalid");
  });
});

describe("AGO-34 QA: the evaluator is deterministic and leaks nothing", () => {
  it("returns the same answer for the same input and never throws on odd inputs", () => {
    const odd = input({ policies: [layer("baseline", "deny", "*")] });
    expect(evaluatePolicy(odd)).toEqual(evaluatePolicy(odd));
    expect(() => evaluatePolicy(input({ call: { toolName: "" } }))).not.toThrow();
  });

  it("the result carries only a fixed reason code and a rule id, never call details", () => {
    const result = evaluatePolicy(
      input({
        policies: [layer("baseline", "deny")],
        call: { argsSummary: "password=hunter2" },
      }),
    );
    expect(Object.keys(result).sort()).toEqual(["decision", "reasonCode", "ruleId"]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
