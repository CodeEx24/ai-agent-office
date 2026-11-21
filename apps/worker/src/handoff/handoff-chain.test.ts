// AGO-81 round 2: a handoff never grants more than the sender holds ON EVERY HOP, a run on a handoff task is
// clamped even when nobody accepted it, and the narrowed budget is enforced at tool-call time.
import { describe, expect, it } from "vitest";

import { createRunEventEmitter } from "../events/run-event-emitter.js";
import {
  HANDOFF_BUDGET_EXHAUSTED,
  createHandoffPolicyHook,
} from "../policy/handoff-policy-hook.js";

import { acceptHandoff, createHandoff } from "./create-handoff.js";
import { createInMemoryHandoffStore } from "./handoff-store.test-helpers.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
import type { PolicyInputs } from "../policy/pg-policy-source.js";
import type { HandoffGrant, HandoffParty } from "@ago/shared/handoff";

const WS = "11111111-1111-4111-8111-111111111111";
const HUMAN = "99999999-9999-4999-8999-999999999999";
const [A, B, C, D, E] = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
] as const;
const RUN = { A: "run-a", B: "run-b", C: "run-c", D: "run-d" } as const;
const SIGNAL = new AbortController().signal;

const grant = (
  capabilityKey: string,
  tier: HandoffGrant["tier"] = 1,
  mode: HandoffGrant["mode"] = "automatic",
): HandoffGrant => ({ capabilityKey, tier, mode, isEnabled: true });

// Every agent holds the same wide set on its own: only the handoffs can narrow it.
const party = (agentId: string): HandoffParty => ({
  agentId,
  workspaceId: WS,
  isArchived: false,
  grants: [grant("vault.read", 0), grant("tasks.manage", 1), grant("email.send", 3, "approval")],
  budgetCents: 500,
  dataScope: [],
});

function setup() {
  const store = createInMemoryHandoffStore();
  for (const id of [A, B, C, D, E]) store.setParty(party(id));
  store.setChainForRun(RUN.A, { workspaceId: WS, requesterMemberId: HUMAN, path: [A] });
  const emitterFor = (runId: string) =>
    createRunEventEmitter({
      workspaceId: WS,
      runId,
      store: {
        insert: () => Promise.resolve({ id: "e", seq: 1, created_at: "2026-11-20T00:00:00Z" }),
      },
    });
  let n = 0;
  const newId = () => `7a5c0000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const hop = (runId: string, agentId: string, to: string, extra: object = {}) =>
    createHandoff(
      { store, emitter: emitterFor(runId), newId },
      { workspaceId: WS, runId, agentId },
      {
        to_agent_id: to,
        title: "t",
        ...extra,
      },
    );
  const take = (runId: string, agentId: string, taskId: string) =>
    acceptHandoff(
      { store, emitter: emitterFor(runId), newId },
      { workspaceId: WS, runId, agentId },
      taskId,
    );
  return { store, hop, take };
}

describe("a handoff is never wider than what the sender was handed (2-hop and 3-hop)", () => {
  it("2 hops: B cannot pass on to C what A did not pass on to B, though B holds it itself", async () => {
    const { store, hop, take } = setup();
    const first = await hop(RUN.A, A, B, { requested: { capabilities: ["vault.read"] } });
    if (!first.ok) throw new Error(`setup failed: ${first.reason}`);
    await take(RUN.B, B, first.taskId);

    expect(await hop(RUN.B, B, C, { requested: { capabilities: ["tasks.manage"] } })).toEqual({
      ok: false,
      reason: "widening_capability",
    });
    expect(await hop(RUN.B, B, C, { requested: { capabilities: ["email.send"] } })).toEqual({
      ok: false,
      reason: "widening_capability",
    });
    // Asking for nothing in particular gives C only what B was handed.
    const second = await hop(RUN.B, B, C);
    expect(second.ok).toBe(true);
    expect(store.records[1]?.narrowed.capabilities.map((g) => g.capabilityKey)).toEqual([
      "vault.read",
    ]);
  });

  it("3 hops: the set only shrinks; tier and approval mode never loosen", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, {
      requested: { capabilities: ["vault.read", "email.send"] },
    });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    const two = await hop(RUN.B, B, C, { requested: { capabilities: ["vault.read"] } });
    if (!two.ok) throw new Error(`setup failed: ${two.reason}`);
    await take(RUN.C, C, two.taskId);

    // email.send was dropped on hop 2, so C cannot hand it to D.
    expect(await hop(RUN.C, C, D, { requested: { capabilities: ["email.send"] } })).toEqual({
      ok: false,
      reason: "widening_capability",
    });
    const three = await hop(RUN.C, C, D);
    if (!three.ok) throw new Error(`setup failed: ${three.reason}`);
    expect(three.depth).toBe(3);
    expect(store.records[2]?.narrowed.capabilities).toEqual([
      { capabilityKey: "vault.read", tier: 0, mode: "automatic" },
    ]);
    // The first hop kept email.send at tier 3 with approval: a handoff does not loosen it.
    expect(store.records[0]?.narrowed.capabilities).toContainEqual({
      capabilityKey: "email.send",
      tier: 3,
      mode: "approval",
    });
    // Depth 4 is refused.
    await take(RUN.D, D, three.taskId);
    expect(await hop(RUN.D, D, E)).toEqual({ ok: false, reason: "depth_exceeded" });
  });

  it("the budget only shrinks along the chain", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    expect(await hop(RUN.B, B, C, { requested: { budget_cents: 101 } })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
    const two = await hop(RUN.B, B, C);
    expect(two.ok).toBe(true);
    expect(store.records[1]?.narrowed.budgetCents).toBe(100);
  });

  it("hop 2+ is capped by the parent's REMAINING budget (budget minus what its task already spent)", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    store.setSpentCents(WS, one.taskId, 60);
    // 100 - 60 = 40 left: 41 is wider, and a request with no budget gets the remaining 40.
    expect(await hop(RUN.B, B, C, { requested: { budget_cents: 41 } })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
    const defaulted = await hop(RUN.B, B, C);
    expect(defaulted.ok).toBe(true);
    expect(store.records.at(-1)?.narrowed.budgetCents).toBe(40);
  });

  it("a sender cannot split its remaining budget across several children (budget already given is held)", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    store.setSpentCents(WS, one.taskId, 60); // 40 left
    expect((await hop(RUN.B, B, C, { requested: { budget_cents: 25 } })).ok).toBe(true);
    // 15 left after the first child: 16 is wider, a second child asking for the whole 40 again is refused.
    expect(await hop(RUN.B, B, D, { requested: { budget_cents: 16 } })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
    expect(await hop(RUN.B, B, D, { requested: { budget_cents: 40 } })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
    expect((await hop(RUN.B, B, D, { requested: { budget_cents: 15 } })).ok).toBe(true);
    // Nothing is left: any further child is refused, whatever it asks for.
    expect((await hop(RUN.B, B, E, { requested: { budget_cents: 1 } })).ok).toBe(false);
    expect((await hop(RUN.B, B, E)).ok).toBe(false);
    expect(store.records.map((r) => r.narrowed.budgetCents)).toEqual([100, 25, 15]);
  });

  it("hop 1: several children of one task cannot pass on more than the sender's daily remaining", async () => {
    const { store, hop } = setup(); // every agent holds a 500 cent daily budget
    expect((await hop(RUN.A, A, B, { requested: { budget_cents: 300 } })).ok).toBe(true);
    expect(await hop(RUN.A, A, C, { requested: { budget_cents: 201 } })).toEqual({
      ok: false,
      reason: "widening_budget",
    });
    expect((await hop(RUN.A, A, C, { requested: { budget_cents: 200 } })).ok).toBe(true);
    expect((await hop(RUN.A, A, D, { requested: { budget_cents: 1 } })).ok).toBe(false);
    expect(store.records).toHaveLength(2);
  });

  it("a parent that spent its whole budget cannot hand anything on", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    store.setSpentCents(WS, one.taskId, 150); // an overrun never goes negative
    expect((await hop(RUN.B, B, C)).ok).toBe(false);
    expect(store.records).toHaveLength(1);
  });

  it("a sender that does not exist is sender_not_found, not archived", async () => {
    const { hop } = setup();
    expect(await hop(RUN.A, "ffffffff-ffff-4fff-8fff-ffffffffffff", B)).toEqual({
      ok: false,
      reason: "sender_not_found",
    });
  });
});

describe("the receiver's run is clamped even when no run accepted the handoff", () => {
  const call = (capabilityKey: string, tier: PolicyToolCall["tier"]): PolicyToolCall => ({
    callId: "call-1",
    toolName: "tool",
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
  const own: PolicyInputs = {
    agent: {
      mode: "standard",
      grants: [
        { capabilityKey: "vault.read", tier: 0, mode: "automatic", isEnabled: true },
        { capabilityKey: "tasks.manage", tier: 1, mode: "automatic", isEnabled: true },
      ],
    },
    policies: [],
  };
  const source = { load: () => Promise.resolve(own) };

  it("a run inserted for the handoff task, never accepted, gets the intersection and not B's own grants", async () => {
    const { store, hop } = setup();
    const made = await hop(RUN.A, A, B, { requested: { capabilities: ["vault.read"] } });
    if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
    // A run on the task with no acceptHandoff call (what a queue or a member could create).
    store.setRunTask(WS, "unlinked-run", made.taskId);
    const hook = createHandoffPolicyHook({ store, source });
    expect((await hook.check(call("vault.read", 0), context("unlinked-run", B))).decision).toBe(
      "allow",
    );
    expect(await hook.check(call("tasks.manage", 1), context("unlinked-run", B))).toMatchObject({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });

  it("a second run on the same task is clamped too", async () => {
    const { store, hop, take } = setup();
    const made = await hop(RUN.A, A, B, { requested: { capabilities: ["vault.read"] } });
    if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
    await take(RUN.B, B, made.taskId);
    store.setRunTask(WS, "second-run", made.taskId);
    const hook = createHandoffPolicyHook({ store, source });
    expect(await hook.check(call("tasks.manage", 1), context("second-run", B))).toMatchObject({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });

  it("an ordinary run is unchanged", async () => {
    const { store } = setup();
    const hook = createHandoffPolicyHook({ store, source });
    expect((await hook.check(call("tasks.manage", 1), context("plain-run", B))).decision).toBe(
      "allow",
    );
  });

  it("a Tier 3 action through a handoff still needs approval", async () => {
    const { store, hop } = setup();
    const made = await hop(RUN.A, A, B, { requested: { capabilities: ["email.send"] } });
    if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
    store.setRunTask(WS, "run-x", made.taskId);
    const wide: PolicyInputs = {
      agent: {
        mode: "standard",
        grants: [{ capabilityKey: "email.send", tier: 1, mode: "automatic", isEnabled: true }],
      },
      policies: [],
    };
    const hook = createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(wide) } });
    expect((await hook.check(call("email.send", 1), context("run-x", B))).decision).toBe(
      "needs_approval",
    );
  });
});

describe("the narrowed budget is enforced at tool-call time", () => {
  const call: PolicyToolCall = {
    callId: "call-1",
    toolName: "tool",
    input: {},
    capabilityKey: "vault.read",
    tier: 0,
    isRegistered: true,
  };
  const context: PolicyContext = {
    workspaceId: WS,
    runId: "run-x",
    agentId: B,
    step: 1,
    signal: SIGNAL,
  };
  const own: PolicyInputs = {
    agent: {
      mode: "standard",
      grants: [{ capabilityKey: "vault.read", tier: 0, mode: "automatic", isEnabled: true }],
    },
    policies: [],
  };

  it("allows under the cap and denies once the runs on the task have spent it", async () => {
    const { store, hop } = setup();
    const made = await hop(RUN.A, A, B, { requested: { budget_cents: 50 } });
    if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
    store.setRunTask(WS, "run-x", made.taskId);
    const hook = createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(own) } });

    store.setSpentCents(WS, made.taskId, 49);
    expect((await hook.check(call, context)).decision).toBe("allow");
    store.setSpentCents(WS, made.taskId, 50);
    expect(await hook.check(call, context)).toMatchObject({
      decision: "deny",
      reasonCode: HANDOFF_BUDGET_EXHAUSTED,
    });
  });

  const contextOf = (runId: string, agentId: string): PolicyContext => ({
    ...context,
    runId,
    agentId,
  });

  it("round 5, depth 1: a task that gave budget to a child cannot spend it again (100 granted, 60 given, 40 left)", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    const hook = createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(own) } });

    expect((await hook.check(call, contextOf(RUN.B, B))).decision).toBe("allow");
    const two = await hop(RUN.B, B, C, { requested: { budget_cents: 60 } });
    if (!two.ok) throw new Error(`setup failed: ${two.reason}`);

    store.setSpentCents(WS, one.taskId, 39);
    expect((await hook.check(call, contextOf(RUN.B, B))).decision).toBe("allow");
    store.setSpentCents(WS, one.taskId, 40); // its own 40 are spent: the 60 given away are not its to spend
    expect(await hook.check(call, contextOf(RUN.B, B))).toMatchObject({
      decision: "deny",
      reasonCode: HANDOFF_BUDGET_EXHAUSTED,
    });
  });

  it("round 5: a task that gave its whole budget away is denied at once", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    expect((await hop(RUN.B, B, C, { requested: { budget_cents: 100 } })).ok).toBe(true);
    const hook = createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(own) } });
    expect(await hook.check(call, contextOf(RUN.B, B))).toMatchObject({
      decision: "deny",
      reasonCode: HANDOFF_BUDGET_EXHAUSTED,
    });
  });

  it("round 5, depth 3: the limits of the whole chain add up to the first grant, never more (100 = 40 + 30 + 30)", async () => {
    const { store, hop, take } = setup();
    const one = await hop(RUN.A, A, B, { requested: { budget_cents: 100 } });
    if (!one.ok) throw new Error(`setup failed: ${one.reason}`);
    await take(RUN.B, B, one.taskId);
    const two = await hop(RUN.B, B, C, { requested: { budget_cents: 60 } });
    if (!two.ok) throw new Error(`setup failed: ${two.reason}`);
    await take(RUN.C, C, two.taskId);
    const three = await hop(RUN.C, C, D, { requested: { budget_cents: 30 } });
    if (!three.ok) throw new Error(`setup failed: ${three.reason}`);
    await take(RUN.D, D, three.taskId);
    const hook = createHandoffPolicyHook({ store, source: { load: () => Promise.resolve(own) } });

    // B holds 100 - 60 = 40, C holds 60 - 30 = 30, D holds 30. Each is denied exactly at its own limit.
    const limits = [
      { run: RUN.B, agent: B, task: one.taskId, limit: 40 },
      { run: RUN.C, agent: C, task: two.taskId, limit: 30 },
      { run: RUN.D, agent: D, task: three.taskId, limit: 30 },
    ];
    for (const { run, agent, task, limit } of limits) {
      store.setSpentCents(WS, task, limit - 1);
      expect((await hook.check(call, contextOf(run, agent))).decision).toBe("allow");
      store.setSpentCents(WS, task, limit);
      expect(await hook.check(call, contextOf(run, agent))).toMatchObject({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
    }
    expect(limits.reduce((sum, l) => sum + l.limit, 0)).toBe(100);
  });
});
