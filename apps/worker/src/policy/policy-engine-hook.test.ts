import { describe, expect, it } from "vitest";

import { createPolicyEngineHook } from "./policy-engine-hook.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
import type { PolicyInputs, PolicySource } from "./pg-policy-source.js";

const context: PolicyContext = {
  workspaceId: "w",
  runId: "r",
  agentId: "a",
  step: 1,
  signal: new AbortController().signal,
};

const call = (over: Partial<PolicyToolCall> = {}): PolicyToolCall => ({
  callId: "c1",
  toolName: "read_note",
  input: { path: "secret.md" },
  tier: 0,
  capabilityKey: "vault.read",
  isRegistered: true,
  ...over,
});

const inputs = (over: Partial<PolicyInputs> & { tier?: 0 | 1 | 2 | 3 | 4 } = {}): PolicyInputs => ({
  agent: {
    mode: "strict",
    grants: [
      { capabilityKey: "vault.read", tier: over.tier ?? 0, mode: "automatic", isEnabled: true },
    ],
  },
  policies: [],
  ...over,
});

const hookFor = (value: PolicyInputs | Error) =>
  createPolicyEngineHook({
    source: {
      load: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
    } satisfies PolicySource,
  });

describe("policy engine hook", () => {
  it("allows a granted tier-0 call", async () => {
    await expect(hookFor(inputs()).check(call(), context)).resolves.toEqual({
      decision: "allow",
      reasonCode: "allowed_tier0",
    });
  });

  it("AC1: a tier 3 call becomes needs_approval, never allow", async () => {
    const result = await hookFor(inputs({ tier: 3 })).check(call({ tier: 3 }), context);
    expect(result).toEqual({ decision: "needs_approval", reasonCode: "tier_requires_approval" });
  });

  it("AC2: a deny rule at any level denies and names the rule, not the input", async () => {
    const result = await hookFor(
      inputs({
        policies: [
          {
            id: "pol-1",
            level: "baseline",
            rule: { version: 1, rules: [{ action: "vault.*", effect: "deny" }] },
          },
        ],
      }),
    ).check(call(), context);
    expect(result).toEqual({ decision: "deny", reasonCode: "deny_rule", ruleId: "pol-1:0" });
    expect(JSON.stringify(result)).not.toContain("secret.md");
  });

  it("denies an ungranted capability", async () => {
    const result = await hookFor(inputs()).check(call({ capabilityKey: "web.search" }), context);
    expect(result).toEqual({ decision: "deny", reasonCode: "not_granted" });
  });

  it("denies an unregistered tool without loading anything", async () => {
    const hook = createPolicyEngineHook({
      source: {
        load: () => Promise.reject(new Error("must not be called")),
      },
    });
    const result = await hook.check(call({ isRegistered: false, tier: 4 }), context);
    expect(result).toEqual({ decision: "deny", reasonCode: "unknown_tool" });
  });

  it("allows the built-in get_current_time with no grant, and denies other keyless tools", async () => {
    const hook = hookFor(inputs({ agent: { mode: "strict", grants: [] } }));
    const { capabilityKey: _omitted, ...keyless } = call({ toolName: "get_current_time" });
    await expect(hook.check(keyless, context)).resolves.toMatchObject({ decision: "allow" });
    await expect(hook.check({ ...keyless, toolName: "mystery_tool" }, context)).resolves.toEqual({
      decision: "deny",
      reasonCode: "no_capability",
    });
  });

  it("lets a load failure reach the loop, which turns a throw into a deny", async () => {
    await expect(hookFor(new Error("db down")).check(call(), context)).rejects.toThrow("db down");
  });
});
