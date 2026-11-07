import { describe, expect, it } from "vitest";

import { createDenyByDefaultPolicyHook, DEFAULT_TIER0_ALLOWLIST } from "./policy-hook.js";

import type { PolicyContext, PolicyToolCall } from "./policy-hook.js";

const context: PolicyContext = {
  workspaceId: "w",
  runId: "r",
  agentId: "a",
  step: 1,
  signal: new AbortController().signal,
};
const call = (over: Partial<PolicyToolCall>): PolicyToolCall => ({
  callId: "c1",
  toolName: "get_current_time",
  input: {},
  tier: 0,
  isRegistered: true,
  ...over,
});

describe("default (deny-by-default) policy hook", () => {
  const hook = createDenyByDefaultPolicyHook();

  it("allows only the explicit tier-0 allowlist", async () => {
    expect(DEFAULT_TIER0_ALLOWLIST).toEqual(["get_current_time"]);
    await expect(hook.check(call({}), context)).resolves.toEqual({
      decision: "allow",
      reasonCode: "tier0_allowlist",
    });
  });

  it("denies a tier-0 tool that is not on the allowlist", async () => {
    const result = await hook.check(call({ toolName: "read_secret_notes" }), context);
    expect(result).toEqual({ decision: "deny", reasonCode: "default_deny" });
  });

  it("denies an allowlisted name when the registered tool is not tier 0", async () => {
    const result = await hook.check(call({ tier: 2 }), context);
    expect(result.decision).toBe("deny");
  });

  it("denies a tool that is not registered", async () => {
    const result = await hook.check(call({ isRegistered: false, tier: 4 }), context);
    expect(result).toEqual({ decision: "deny", reasonCode: "unknown_tool" });
  });

  it("denies every tier from 1 to 4", async () => {
    for (const tier of [1, 2, 3, 4] as const) {
      const result = await hook.check(call({ tier }), context);
      expect(result.decision).toBe("deny");
    }
  });
});
