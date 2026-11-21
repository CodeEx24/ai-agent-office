import { describe, expect, it } from "vitest";

import { extendChain, intersectDataScopes, narrowHandoff } from "./handoff-rules.js";
import { MAX_HANDOFF_DEPTH, handoffRequestSchema } from "./handoff-schemas.js";

import type { HandoffChain, HandoffGrant, HandoffParty } from "./handoff-schemas.js";

const WS = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MEMBER = "99999999-9999-4999-8999-999999999999";

const grant = (
  capabilityKey: string,
  tier: HandoffGrant["tier"] = 1,
  mode: HandoffGrant["mode"] = "automatic",
  isEnabled = true,
): HandoffGrant => ({ capabilityKey, tier, mode, isEnabled });

const party = (agentId: string, over: Partial<HandoffParty> = {}): HandoffParty => ({
  agentId,
  workspaceId: WS,
  isArchived: false,
  grants: [grant("vault.read", 0), grant("tasks.manage", 1)],
  budgetCents: 500,
  dataScope: ["projects/"],
  ...over,
});

describe("narrowHandoff: the receiver gets the intersection, never a union", () => {
  it("keeps only capabilities both agents hold", () => {
    const sender = party(A, { grants: [grant("vault.read", 0), grant("web.search", 1)] });
    const receiver = party(B, { grants: [grant("vault.read", 0), grant("tasks.manage", 1)] });
    const result = narrowHandoff(sender, receiver, undefined);
    expect(result.ok && result.permissions.capabilities.map((c) => c.capabilityKey)).toEqual([
      "vault.read",
    ]);
  });

  it("never gives the receiver a capability the sender lacks, even if the receiver has it", () => {
    const sender = party(A, { grants: [grant("vault.read", 0)] });
    const receiver = party(B, {
      grants: [grant("vault.read", 0), grant("email.send", 3, "approval")],
    });
    const result = narrowHandoff(sender, receiver, undefined);
    expect(result.ok && result.permissions.capabilities.map((c) => c.capabilityKey)).toEqual([
      "vault.read",
    ]);
  });

  it("ignores a disabled grant on either side", () => {
    const sender = party(A, { grants: [grant("vault.read", 0, "automatic", false)] });
    const result = narrowHandoff(sender, party(B), undefined);
    expect(result.ok && result.permissions.capabilities).toEqual([]);
  });

  it("takes the higher (stricter) tier and approval mode when either side requires it", () => {
    const sender = party(A, { grants: [grant("tasks.manage", 1, "approval")] });
    const receiver = party(B, { grants: [grant("tasks.manage", 2, "automatic")] });
    const result = narrowHandoff(sender, receiver, undefined);
    expect(result.ok && result.permissions.capabilities).toEqual([
      { capabilityKey: "tasks.manage", tier: 2, mode: "approval" },
    ]);
  });

  it("never lowers a tier 3 or 4 capability and never makes it automatic", () => {
    const sender = party(A, { grants: [grant("email.send", 3, "approval")] });
    const receiver = party(B, { grants: [grant("email.send", 1, "automatic")] });
    const result = narrowHandoff(sender, receiver, undefined);
    expect(result.ok && result.permissions.capabilities).toEqual([
      { capabilityKey: "email.send", tier: 3, mode: "approval" },
    ]);
  });

  it("budget is the smallest of sender, receiver and request", () => {
    const result = narrowHandoff(party(A, { budgetCents: 500 }), party(B, { budgetCents: 300 }), {
      budget_cents: 400,
    });
    expect(result.ok && result.permissions.budgetCents).toBe(300);
  });

  it("data scope is the overlap of both lists", () => {
    const result = narrowHandoff(
      party(A, { dataScope: ["projects/", "notes/"] }),
      party(B, { dataScope: ["projects/sales/", "other/"] }),
      undefined,
    );
    expect(result.ok && result.permissions.dataScope).toEqual(["projects/sales/"]);
  });

  it("denies a request for a capability the sender lacks (more capabilities)", () => {
    expect(narrowHandoff(party(A), party(B), { capabilities: ["email.send"] })).toEqual({
      ok: false,
      reason: "widening_capability",
    });
  });

  it("denies a request for more budget than the sender has (bigger budget)", () => {
    expect(narrowHandoff(party(A, { budgetCents: 100 }), party(B), { budget_cents: 101 })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
  });

  it("denies a request for data outside the sender's scope", () => {
    expect(narrowHandoff(party(A), party(B), { data_scope: ["secrets/"] })).toEqual({
      ok: false,
      reason: "widening_scope",
    });
    expect(
      narrowHandoff(party(A, { dataScope: ["projects/sales/"] }), party(B), {
        data_scope: ["projects/"],
      }),
    ).toEqual({ ok: false, reason: "widening_scope" });
  });

  it("denies another workspace", () => {
    const other = party(B, { workspaceId: "22222222-2222-4222-8222-222222222222" });
    expect(narrowHandoff(party(A), other, undefined)).toEqual({
      ok: false,
      reason: "workspace_mismatch",
    });
  });

  it("denies a handoff with no budget left", () => {
    expect(narrowHandoff(party(A, { budgetCents: 0 }), party(B), undefined)).toEqual({
      ok: false,
      reason: "no_budget",
    });
  });

  it("the result is always a subset of both parties (property check over many shapes)", () => {
    const keys = ["a.x", "b.y", "c.z", "d.w"];
    for (let s = 0; s < 16; s += 1) {
      for (let r = 0; r < 16; r += 1) {
        const pick = (mask: number, tier: 0 | 1 | 2 | 3): HandoffGrant[] =>
          keys.filter((_, i) => (mask >> i) & 1).map((k) => grant(k, tier));
        const sender = party(A, { grants: pick(s, 1) });
        const receiver = party(B, { grants: pick(r, 2) });
        const result = narrowHandoff(sender, receiver, undefined);
        if (!result.ok) continue;
        for (const c of result.permissions.capabilities) {
          expect(sender.grants.some((g) => g.capabilityKey === c.capabilityKey)).toBe(true);
          expect(receiver.grants.some((g) => g.capabilityKey === c.capabilityKey)).toBe(true);
          expect(c.tier).toBeGreaterThanOrEqual(2);
        }
        expect(result.permissions.budgetCents).toBeLessThanOrEqual(
          Math.min(sender.budgetCents, receiver.budgetCents),
        );
      }
    }
  });
});

describe("intersectDataScopes", () => {
  it("returns the narrower prefix of each overlapping pair and nothing for disjoint lists", () => {
    expect(intersectDataScopes(["a/"], ["a/b/"])).toEqual(["a/b/"]);
    expect(intersectDataScopes(["a/b/"], ["a/"])).toEqual(["a/b/"]);
    expect(intersectDataScopes(["a/"], ["b/"])).toEqual([]);
    expect(intersectDataScopes([], ["a/"])).toEqual([]);
  });
  it("does not treat a name prefix as a folder prefix", () => {
    expect(intersectDataScopes(["proj/"], ["projects/"])).toEqual([]);
  });
});

describe("extendChain", () => {
  const chain = (path: string[]): HandoffChain => ({
    workspaceId: WS,
    requesterMemberId: MEMBER,
    path,
  });

  it("extends a chain and keeps the requester", () => {
    expect(extendChain(chain([A]), B)).toEqual({ ok: true, depth: 1, chain: chain([A, B]) });
  });
  it("refuses a self-handoff and a cycle", () => {
    expect(extendChain(chain([A]), A)).toEqual({ ok: false, reason: "self_handoff" });
    expect(extendChain(chain([A, B]), A)).toEqual({ ok: false, reason: "cycle" });
  });
  it(`allows depth ${String(MAX_HANDOFF_DEPTH)} and refuses the next hop`, () => {
    expect(extendChain(chain([A, B, C]), D)).toMatchObject({ ok: true, depth: 3 });
    expect(extendChain(chain([A, B, C, D]), E)).toEqual({ ok: false, reason: "depth_exceeded" });
  });
  it("refuses an empty path", () => {
    expect(extendChain(chain([]), B)).toEqual({ ok: false, reason: "invalid_request" });
  });
});

describe("handoffRequestSchema is strict (forgery is rejected, not ignored)", () => {
  const base = { to_agent_id: B, title: "Review the draft" };
  it("accepts a plain request and normalises scope prefixes", () => {
    const parsed = handoffRequestSchema.parse({
      ...base,
      requested: { data_scope: ["projects/sales"] },
    });
    expect(parsed.requested?.data_scope).toEqual(["projects/sales/"]);
    expect(parsed.description).toBe("");
  });
  it.each([
    ["a forged requester", { requester_member_id: MEMBER }],
    ["a forged on_behalf_of", { on_behalf_of: MEMBER }],
    ["an approval", { approval_id: "x" }],
    ["grants", { grants: [] }],
    ["a workspace", { workspace_id: WS }],
    ["a tier", { requested: { tier: 0 } }],
    ["a message", { message: "hello" }],
  ])("rejects %s", (_label, extra) => {
    expect(handoffRequestSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
  it("rejects parent paths and absolute scope prefixes", () => {
    expect(
      handoffRequestSchema.safeParse({ ...base, requested: { data_scope: ["../x"] } }).success,
    ).toBe(false);
    expect(
      handoffRequestSchema.safeParse({ ...base, requested: { data_scope: ["/etc"] } }).success,
    ).toBe(false);
  });
});
