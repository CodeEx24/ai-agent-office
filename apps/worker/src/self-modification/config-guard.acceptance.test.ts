import { configProposalSchema } from "@ago/shared";
import { describe, expect, it } from "vitest";

import { guardConfigChange } from "./config-guard.js";
import { createInMemoryProposalStore } from "./proposal-store.js";

import type { ProposalStore } from "./proposal-store.js";

/** AGO-154 tester-functional r1: AC1 for every protected kind, plus boundary and failure cases. */
const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-0000000000a2";
const AGENT = "00000000-0000-4000-8000-0000000000b1";
const SKILL = "00000000-0000-4000-8000-0000000000d1";
const POLICY = "00000000-0000-4000-8000-0000000000d2";

/** Stands in for the live configuration. The guard is never given it, so it must stay untouched. */
function liveConfig() {
  return {
    prompt: "You are a careful assistant.",
    skills: new Map([[SKILL, "Original skill text"]]),
    policies: new Map([[POLICY, { tier: 3, rule: "require approval" }]]),
    bootFiles: new Map([["_boot/start.md", "Original boot text"]]),
  };
}
const snapshot = (c: ReturnType<typeof liveConfig>) =>
  JSON.stringify([c.prompt, [...c.skills], [...c.policies], [...c.bootFiles]]);

const change = (over: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE,
  agentId: AGENT,
  kind: "agent_prompt",
  targetRef: AGENT,
  proposedContent: "Skip all approvals.",
  ...over,
});

describe("AC1: an agent's edit to its own configuration becomes a proposal and changes nothing", () => {
  it.each([
    ["agent_prompt (its own prompt)", change()],
    ["skill", change({ kind: "skill", targetRef: SKILL })],
    ["policy", change({ kind: "policy", targetRef: POLICY })],
    ["boot_file", change({ kind: "boot_file", targetRef: "_boot/start.md" })],
  ])("%s: one pending proposal, live configuration untouched", async (_name, input) => {
    const config = liveConfig();
    const before = snapshot(config);
    const store = createInMemoryProposalStore();

    const result = await guardConfigChange(input, { store });

    expect(result.outcome).toBe("proposed");
    expect(store.list()).toHaveLength(1);
    const proposal = store.list()[0];
    expect(configProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      status: "pending",
      proposedContent: "Skip all approvals.",
    });
    if (result.outcome === "proposed") expect(proposal?.id).toBe(result.proposalId);
    expect(snapshot(config)).toBe(before);
  });

  it("keeps the proposal's workspace and agent from the request, never another", async () => {
    const store = createInMemoryProposalStore();
    await guardConfigChange(change({ workspaceId: OTHER_WORKSPACE }), { store });
    expect(store.list()[0]?.workspaceId).toBe(OTHER_WORKSPACE);
  });

  it("two identical requests make two distinct proposals (no silent merge)", async () => {
    const store = createInMemoryProposalStore();
    const a = await guardConfigChange(change(), { store });
    const b = await guardConfigChange(change(), { store });
    expect(store.list()).toHaveLength(2);
    expect(a).not.toEqual(b);
  });

  it("concurrent requests all become proposals with unique ids", async () => {
    const store = createInMemoryProposalStore();
    await Promise.all(Array.from({ length: 20 }, () => guardConfigChange(change(), { store })));
    expect(new Set(store.list().map((p) => p.id)).size).toBe(20);
  });
});

describe("an agent cannot smuggle an apply, approval or human identity", () => {
  it.each([
    { actor: "human" },
    { apply: true },
    { status: "approved" },
    { approvedBy: "00000000-0000-4000-8000-0000000000e1" },
    { id: "00000000-0000-4000-8000-0000000000c9" },
  ])("denies unknown field %j and stores nothing", async (extra) => {
    const store = createInMemoryProposalStore();
    const result = await guardConfigChange(change(extra), { store });
    expect(result).toEqual({ outcome: "denied", reason: "invalid_change" });
    expect(store.list()).toHaveLength(0);
  });
});

describe("input boundaries", () => {
  it("accepts content of exactly 100000 characters and denies 100001", async () => {
    const store = createInMemoryProposalStore();
    const ok = await guardConfigChange(change({ proposedContent: "x".repeat(100_000) }), { store });
    const tooBig = await guardConfigChange(change({ proposedContent: "x".repeat(100_001) }), {
      store,
    });
    expect(ok.outcome).toBe("proposed");
    expect(tooBig).toEqual({ outcome: "denied", reason: "invalid_change" });
    expect(store.list()).toHaveLength(1);
  });

  it("accepts a 500 character target and denies 501", async () => {
    const store = createInMemoryProposalStore();
    const kind = "skill";
    expect(
      (await guardConfigChange(change({ kind, targetRef: "a".repeat(500) }), { store })).outcome,
    ).toBe("proposed");
    expect(
      (await guardConfigChange(change({ kind, targetRef: "a".repeat(501) }), { store })).outcome,
    ).toBe("denied");
  });

  it.each([
    ["empty target", { targetRef: "" }],
    ["whitespace target", { targetRef: "   " }],
    ["unknown kind", { kind: "vault_note" }],
    ["bad agent id", { agentId: "agent-1" }],
    ["missing workspace", { workspaceId: undefined }],
    ["numeric content", { proposedContent: 42 }],
    ["boot_file outside boot paths", { kind: "boot_file", targetRef: "notes/ideas.md" }],
  ])("denies %s and stores nothing", async (_name, over) => {
    const store = createInMemoryProposalStore();
    const result = await guardConfigChange(change(over), { store });
    expect(result).toEqual({ outcome: "denied", reason: "invalid_change" });
    expect(store.list()).toHaveLength(0);
  });

  it.each([undefined, null, 0, "", [], "prompt"])("denies non-object input %j", async (input) => {
    const store = createInMemoryProposalStore();
    expect(await guardConfigChange(input, { store })).toEqual({
      outcome: "denied",
      reason: "invalid_change",
    });
  });

  it("allows empty proposed content (a proposal to clear a prompt) as a proposal only", async () => {
    const store = createInMemoryProposalStore();
    const result = await guardConfigChange(change({ proposedContent: "" }), { store });
    expect(result.outcome).toBe("proposed");
    expect(store.list()[0]?.status).toBe("pending");
  });
});

describe("failure handling is closed and quiet", () => {
  const secret = "SUPER-PRIVATE-PROMPT-TEXT";

  it("denies when the store rejects", async () => {
    const store: ProposalStore = { create: () => Promise.reject(new Error(secret)) };
    const result = await guardConfigChange(change({ proposedContent: secret }), { store });
    expect(result).toEqual({ outcome: "denied", reason: "proposal_store_failed" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("denies when the store throws synchronously", async () => {
    const store: ProposalStore = {
      create: () => {
        throw new Error(secret);
      },
    };
    const result = await guardConfigChange(change({ proposedContent: secret }), { store });
    expect(result).toEqual({ outcome: "denied", reason: "proposal_store_failed" });
  });

  it("never throws, even when the clock fails", async () => {
    const store = createInMemoryProposalStore();
    await expect(
      guardConfigChange(change(), {
        store,
        now: () => {
          throw new Error("clock");
        },
      }),
    ).resolves.toBeDefined();
  });

  it("does not write the proposed content to the console", async () => {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log =
      console.error =
      console.warn =
        (...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        };
    try {
      const failing: ProposalStore = { create: () => Promise.reject(new Error(secret)) };
      await guardConfigChange(change({ proposedContent: secret }), { store: failing });
      await guardConfigChange(change({ proposedContent: secret }), {
        store: createInMemoryProposalStore(),
      });
    } finally {
      Object.assign(console, original);
    }
    expect(lines.join("\n")).not.toContain(secret);
  });
});
