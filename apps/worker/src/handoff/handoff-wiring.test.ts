import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createRunEventEmitter } from "../events/run-event-emitter.js";

import { createHandoffWiring, createUnavailableHandoffStore } from "./handoff-wiring.js";
import { createInMemoryHandoffStore } from "./handoff-store.test-helpers.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
import type { PolicyInputs } from "../policy/pg-policy-source.js";
import type { HandoffGrant, HandoffParty } from "@ago/shared/handoff";

/**
 * The production wiring (AGO-81): the same `createHandoffWiring` that `agent/wire.ts` calls. These tests drive the
 * wired policy hook and the wired tool, so they show the clamp is live in what the run loop actually uses.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HUMAN = "99999999-9999-4999-8999-999999999999";
const RUN_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const RUN_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const SIGNAL = new AbortController().signal;

const grant = (capabilityKey: string, tier: HandoffGrant["tier"] = 1): HandoffGrant => ({
  capabilityKey,
  tier,
  mode: "automatic",
  isEnabled: true,
});

const party = (agentId: string, grants: readonly HandoffGrant[]): HandoffParty => ({
  agentId,
  workspaceId: WS,
  isArchived: false,
  grants,
  budgetCents: 500,
  dataScope: ["projects/"],
});

const emitterFor = (runId: string) =>
  createRunEventEmitter({
    workspaceId: WS,
    runId,
    store: {
      insert: () => Promise.resolve({ id: "e", seq: 1, created_at: "2026-11-20T00:00:00Z" }),
    },
  });

const call = (
  toolName: string,
  capabilityKey: string,
  tier: PolicyToolCall["tier"],
): PolicyToolCall => ({
  callId: "call-1",
  toolName,
  input: {},
  capabilityKey,
  tier,
  isRegistered: true,
});

const context = (runId: string, agentId: string): PolicyContext => ({
  workspaceId: WS,
  runId,
  agentId,
  step: 1,
  signal: SIGNAL,
});

// What the receiver holds on its own: more than the sender passed on.
const receiverOwn: PolicyInputs = {
  agent: {
    mode: "standard",
    grants: [
      { capabilityKey: "vault.read", tier: 0, mode: "automatic", isEnabled: true },
      { capabilityKey: "tasks.manage", tier: 1, mode: "automatic", isEnabled: true },
    ],
  },
  policies: [],
};

function wired() {
  const store = createInMemoryHandoffStore();
  // The sender only holds vault.read; the receiver also holds tasks.manage.
  store.setParty(party(A, [grant("vault.read", 0)]));
  store.setParty(party(B, [grant("vault.read", 0), grant("tasks.manage", 1)]));
  store.setChainForRun(RUN_A, { workspaceId: WS, requesterMemberId: HUMAN, path: [A] });
  const wiring = createHandoffWiring({
    source: { load: () => Promise.resolve(receiverOwn) },
    store,
    emitterFor: (ctx) => emitterFor(ctx.runId),
  });
  return { store, wiring };
}

describe("production handoff wiring", () => {
  it("registers handoff_task as a tier 1 tool behind the policy engine", () => {
    const { wiring } = wired();
    expect(wiring.tool.name).toBe("handoff_task");
    expect(wiring.tool.tier).toBe(1);
    expect(wiring.tool.capabilityKey).toBe("tasks.manage");
  });

  it("an over-broad handoff through the wired tool is denied, not trimmed", async () => {
    const { store, wiring } = wired();
    const ctx = { workspaceId: WS, runId: RUN_A, agentId: A, signal: SIGNAL };
    const result = await wiring.tool.execute(
      { to_agent_id: B, title: "t", requested: { capabilities: ["tasks.manage"] } },
      ctx,
    );
    expect(result).toBe("handoff refused: widening_capability");
    expect(store.records).toHaveLength(0);
  });

  it("a receiver run through the wired hook is clamped to what the sender held", async () => {
    const { store, wiring } = wired();
    const ctx = { workspaceId: WS, runId: RUN_A, agentId: A, signal: SIGNAL };
    const made = await wiring.tool.execute({ to_agent_id: B, title: "t" }, ctx);
    const taskId = /task ([0-9a-f-]{36})$/.exec(made)?.[1];
    if (taskId === undefined) throw new Error("setup failed: " + made);
    expect(await store.markAccepted(WS, taskId, RUN_B)).toBe(true);

    // vault.read was passed on; tasks.manage was not, although the receiver holds it itself.
    expect(
      (await wiring.policy.check(call("read_note", "vault.read", 0), context(RUN_B, B))).decision,
    ).toBe("allow");
    expect(
      await wiring.policy.check(call("create_task", "tasks.manage", 1), context(RUN_B, B)),
    ).toMatchObject({ decision: "deny", reasonCode: "not_granted" });
  });

  it("an ordinary run through the wired hook keeps its own grants", async () => {
    const { wiring } = wired();
    expect(
      (await wiring.policy.check(call("create_task", "tasks.manage", 1), context("r-plain", B)))
        .decision,
    ).toBe("allow");
  });

  it("the fail-closed store (until Postgres lands) refuses every handoff and changes no run", async () => {
    const wiring = createHandoffWiring({
      source: { load: () => Promise.resolve(receiverOwn) },
      store: createUnavailableHandoffStore(),
      emitterFor: (ctx) => emitterFor(ctx.runId),
    });
    const ctx = { workspaceId: WS, runId: RUN_A, agentId: A, signal: SIGNAL };
    expect(await wiring.tool.execute({ to_agent_id: B, title: "t" }, ctx)).toBe(
      "handoff refused: sender_archived",
    );
    expect(
      (await wiring.policy.check(call("create_task", "tasks.manage", 1), context(RUN_B, B)))
        .decision,
    ).toBe("allow");
  });

  it("agent/wire.ts uses this wiring, so the run loop cannot silently drop the clamp", () => {
    const source = readFileSync(new URL("../agent/wire.ts", import.meta.url), "utf8");
    expect(source).toContain("createHandoffWiring");
    expect(source).toContain("policy: handoff.policy");
    expect(source).toContain("handoff.tool");
    expect(source).not.toContain("createPolicyEngineHook");
  });
});
