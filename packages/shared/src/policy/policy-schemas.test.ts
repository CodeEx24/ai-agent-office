import { describe, expect, it } from "vitest";

import {
  MAX_POLICY_RULES,
  POLICY_LEVELS,
  createPolicySchema,
  policyLevelSchema,
  policyRuleSchema,
} from "./policy-schemas.js";

const SCOPE = "96000000-0000-4000-8000-0000000014a1";
const EMPTY_RULE = { version: 1, rules: [] };

describe("policy levels", () => {
  it("lists the layers in the database order", () => {
    expect(POLICY_LEVELS).toEqual(["baseline", "department", "team", "agent"]);
  });

  it.each(["galaxy", "BASELINE", "", null, undefined, 1])(
    "rejects the unknown level %s",
    (value) => {
      expect(policyLevelSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("policyRuleSchema", () => {
  it("accepts an empty rule set and a rule with an optional note", () => {
    expect(policyRuleSchema.safeParse(EMPTY_RULE).success).toBe(true);
    expect(
      policyRuleSchema.safeParse({
        version: 1,
        rules: [{ action: "send_email", effect: "require_approval", note: "a human decides" }],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an array", []],
    ["a string", "deny everything"],
    ["null", null],
    ["a missing version", { rules: [] }],
    ["an unknown version", { version: 2, rules: [] }],
    ["an unknown top-level key", { version: 1, rules: [], tier: 4 }],
    ["an unknown effect", { version: 1, rules: [{ action: "x", effect: "bypass" }] }],
    ["an empty action", { version: 1, rules: [{ action: "", effect: "deny" }] }],
    [
      "an unknown rule key",
      { version: 1, rules: [{ action: "x", effect: "deny", approve: true }] },
    ],
    [
      "too many rules",
      {
        version: 1,
        rules: Array.from({ length: MAX_POLICY_RULES + 1 }, () => ({
          action: "x",
          effect: "deny",
        })),
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(policyRuleSchema.safeParse(value).success).toBe(false);
  });
});

describe("createPolicySchema", () => {
  it("accepts a baseline policy without a scope", () => {
    expect(
      createPolicySchema.safeParse({ level: "baseline", scopeId: null, rule: EMPTY_RULE }).success,
    ).toBe(true);
  });

  it.each(["department", "team", "agent"] as const)("accepts a %s policy with a scope", (level) => {
    expect(createPolicySchema.safeParse({ level, scopeId: SCOPE, rule: EMPTY_RULE }).success).toBe(
      true,
    );
  });

  it("rejects a baseline policy that carries a scope", () => {
    expect(
      createPolicySchema.safeParse({ level: "baseline", scopeId: SCOPE, rule: EMPTY_RULE }).success,
    ).toBe(false);
  });

  it.each(["department", "team", "agent"] as const)(
    "rejects a %s policy without a scope",
    (level) => {
      expect(createPolicySchema.safeParse({ level, scopeId: null, rule: EMPTY_RULE }).success).toBe(
        false,
      );
    },
  );

  it("rejects a scope that is not a uuid", () => {
    expect(
      createPolicySchema.safeParse({ level: "team", scopeId: "marketing", rule: EMPTY_RULE })
        .success,
    ).toBe(false);
  });

  it("rejects fields the caller must not choose (workspace, version, authorship)", () => {
    const base = { level: "baseline", scopeId: null, rule: EMPTY_RULE };
    for (const extra of [{ workspaceId: SCOPE }, { version: 9 }, { createdBy: SCOPE }]) {
      expect(createPolicySchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});
