// AGO-21 functional tests: the human-in-the-loop invariants of the approval request flow, with fakes only.
// Each describe block names the invariant it guards. The developer's own cases live in
// agent-loop.approvals.test.ts; these add the paths and the races it does not cover.
import { describe, expect, it, vi } from "vitest";

import { approvalIdFor } from "../approvals/approval-id.js";
import { ApprovalConflictError, type ApprovalStore } from "../approvals/approval-store.js";
import {
  createMemoryApprovalStore,
  type MemoryApprovalStore,
} from "../approvals/approval-store.test-helpers.js";
import { expireDueApprovals } from "../approvals/expire-approvals.js";
import { createLogger } from "../logger.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.test-helpers.js";
import {
  AGENT,
  OTHER_WS,
  RUN,
  T0,
  TTL_MS,
  WS,
  allowAll,
  attempt,
  decidedEvents,
  denyAll,
  escalateAll,
  failedCodes,
  scriptedModel,
  spyTool,
  types,
  type SpyTool,
} from "./agent-loop.approvals.invariants.test-helpers.js";

import type { RunEventRow } from "../events/index.js";
import type { PolicyHook } from "./policy-hook.js";

const idOf = (callIndex: number): string =>
  approvalIdFor({ runId: RUN, step: 1, callId: `toolu_${String(callIndex)}` });

/** First attempt: the named calls are made, the tier 3 one pauses the run. Returns what a resume needs. */
async function pause(
  options: { calls?: readonly string[]; tools?: readonly SpyTool[]; policy?: PolicyHook } = {},
) {
  const risky = spyTool("risky", 3);
  const tools = options.tools ?? [risky];
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const clock = { now: T0 };
  const first = attempt({
    provider: scriptedModel(options.calls ?? ["risky"]).provider,
    tools,
    checkpoints,
    approvals,
    policy: options.policy ?? allowAll,
    clock,
  });
  const outcome = await first.loop.execute(first.ctx);
  return { risky, tools, checkpoints, approvals, clock, first, outcome };
}

type World = Awaited<ReturnType<typeof pause>>;

function resume(
  world: World,
  approvals: ApprovalStore | undefined = world.approvals,
  calls = ["risky"],
) {
  const model = scriptedModel(calls);
  const next = attempt({
    provider: model.provider,
    tools: world.tools,
    checkpoints: world.checkpoints,
    approvals,
    policy: allowAll,
    clock: world.clock,
  });
  return { ...next, model };
}

/** The same memory store, with some methods replaced. */
const withOverrides = (base: MemoryApprovalStore, over: Partial<ApprovalStore>): ApprovalStore => ({
  ...base,
  ...over,
});

function sweepOf(approvals: ApprovalStore, now: number) {
  const rows: RunEventRow[] = [];
  const wake = vi.fn(() => Promise.resolve("resumed" as const));
  const run = () =>
    expireDueApprovals({
      approvals,
      events: {
        insert: (row) => {
          rows.push(row);
          return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
        },
      },
      control: { resumeAfterApprovalExpiry: wake },
      logger: createLogger({ level: "silent" }),
      now: () => now,
    });
  return { rows, wake, run };
}

describe("invariant 1: the tool runs in no path that is not an approval it honours", () => {
  it("never runs on the first attempt, even for a tier 3 call the policy allows", async () => {
    const world = await pause();

    expect(world.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it.each(["approved", "consumed", "APPROVED", "", "something_new"])(
    "does not run a resumed call whose approval status is %j",
    async (status) => {
      const world = await pause();
      world.approvals.setStatus(idOf(0), status);
      const b = resume(world);

      await b.loop.execute(b.ctx);

      expect(world.risky.run).not.toHaveBeenCalled();
      expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
    },
  );

  it("does not run an approved row that is also past its expiry (approved is not honoured before AGO-47)", async () => {
    const world = await pause();
    world.approvals.setStatus(idOf(0), "approved");
    world.clock.now = T0 + TTL_MS * 100;
    const b = resume(world);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
    expect(world.approvals.peek(idOf(0))?.status).toBe("approved");
  });

  it.each(["rejected", "denied", "approved"])(
    "treats a %s row bound to another payload as not granted, never as its own status",
    async (status) => {
      const world = await pause();
      const mismatched = createMemoryApprovalStore();
      await mismatched.create({
        workspaceId: WS,
        runId: RUN,
        agentId: AGENT,
        approvalId: idOf(0),
        action: "risky",
        payloadHash: "f".repeat(64),
        expiresAt: new Date(T0 + TTL_MS),
      });
      mismatched.setStatus(idOf(0), status);
      const b = resume(world, mismatched);

      await b.loop.execute(b.ctx);

      expect(world.risky.run).not.toHaveBeenCalled();
      expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
    },
  );

  it("denies as expired when the row is past due and the store still reports it pending after the expiry attempt", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const stuck = withOverrides(world.approvals, { expire: () => Promise.resolve(null) });
    const b = resume(world, stuck);

    await b.loop.execute(b.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
  });

  it("does not run the tool, and errors the attempt, when the approval cannot be read on resume", async () => {
    const world = await pause();
    const broken = withOverrides(world.approvals, {
      get: () => Promise.reject(new Error("db down")),
    });
    const b = resume(world, broken);

    await expect(b.loop.execute(b.ctx)).rejects.toThrow("db down");
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("does not run the tool, and errors the attempt, when the late approval cannot be expired", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const broken = withOverrides(world.approvals, {
      expire: () => Promise.reject(new Error("db down")),
    });
    const b = resume(world, broken);

    await expect(b.loop.execute(b.ctx)).rejects.toThrow("db down");
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("runs the tier 0 call that follows the pending one but never the pending one itself", async () => {
    const clock = spyTool("clock", 0);
    const risky = spyTool("risky", 3);
    const world = await pause({ calls: ["risky", "clock"], tools: [risky, clock] });
    expect(clock.run).not.toHaveBeenCalled(); // the pause stops the step before the next call
    world.clock.now = T0 + TTL_MS;
    const b = resume(world, world.approvals, ["risky", "clock"]);

    await b.loop.execute(b.ctx);

    expect(risky.run).not.toHaveBeenCalled();
    expect(clock.run).toHaveBeenCalledTimes(1);
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
  });

  it("does not run a call on a second resume after its approval was closed", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const b = resume(world);
    await b.loop.execute(b.ctx);
    const c = resume(world);

    await c.loop.execute(c.ctx);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(decidedEvents([...b.rows, ...c.rows])).toHaveLength(1);
  });
});

describe("invariant 2: timeout means deny even when the sweep never runs", () => {
  it("denies at the resume check a call that is long overdue, with no sweeper involved", async () => {
    const world = await pause();
    world.clock.now = T0 + 7 * 24 * 60 * 60 * 1_000;
    const b = resume(world);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(idOf(0))?.status).toBe("rejected");
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
  });

  it("keeps waiting one millisecond before the deadline and denies at the deadline", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS - 1;
    const early = resume(world);
    expect(await early.loop.execute(early.ctx)).toMatchObject({ end: "paused" });

    world.clock.now = T0 + TTL_MS;
    const due = resume(world);
    expect(await due.loop.execute(due.ctx)).toMatchObject({ end: "completed" });

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(due.rows)).toEqual(["approval_expired"]);
  });

  it("tells the model the call expired and was not run", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const b = resume(world);

    await b.loop.execute(b.ctx);

    const told = JSON.stringify(b.model.requests.at(-1)?.messages);
    expect(told).toContain("expired before a human answered");
    expect(told).toContain("It was not run");
  });

  it("records the decision as expired by timeout, bound to the stored payload hash", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const b = resume(world);

    await b.loop.execute(b.ctx);

    const [decided] = decidedEvents(b.rows);
    expect(decided?.payload).toMatchObject({
      approval_id: idOf(0),
      outcome: "expired",
      decided_by: "timeout",
      payload_hash: world.approvals.peek(idOf(0))?.payloadHash,
    });
    // No tool input or other free text rides along.
    expect(Object.keys(decided?.payload ?? {}).sort()).toEqual(
      ["approval_id", "decided_by", "outcome", "payload_hash", "version"].sort(),
    );
  });
});

describe("invariant 3: no approval row without a call that needs a human", () => {
  it.each([
    ["tier 3 with an allowing policy", 3, allowAll, 1],
    ["tier 4 with an allowing policy", 4, allowAll, 1],
    ["tier 0 with an allowing policy", 0, allowAll, 0],
    ["tier 1 with an allowing policy", 1, allowAll, 0],
    ["tier 3 with a denying policy", 3, denyAll, 0],
    ["tier 2 with an escalating policy", 2, escalateAll, 1],
  ] as const)("creates the expected number of rows for %s", async (_name, tier, policy, rows) => {
    const approvals = createMemoryApprovalStore();
    const t = spyTool("thing", tier);
    const a = attempt({
      provider: scriptedModel(["thing"]).provider,
      tools: [t],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy,
      clock: { now: T0 },
    });

    await a.loop.execute(a.ctx);

    expect(approvals.all()).toHaveLength(rows);
    expect(types(a.rows).includes("approval.requested")).toBe(rows === 1);
  });

  it("creates no row for an unknown tool even when the policy allows or escalates it", async () => {
    for (const policy of [allowAll, escalateAll]) {
      const approvals = createMemoryApprovalStore();
      const a = attempt({
        provider: scriptedModel(["ghost"]).provider,
        tools: [spyTool("read", 1)],
        checkpoints: createMemoryCheckpointStore(),
        approvals,
        policy,
        clock: { now: T0 },
      });

      await a.loop.execute(a.ctx);

      expect(approvals.all()).toHaveLength(0);
      expect(types(a.rows)).not.toContain("approval.requested");
    }
  });

  it("creates no row when the policy hook throws or answers nonsense (both are a deny)", async () => {
    const throwing: PolicyHook = { check: () => Promise.reject(new Error("boom")) };
    const nonsense: PolicyHook = {
      check: () => Promise.resolve({ decision: "maybe" } as never),
    };
    for (const policy of [throwing, nonsense]) {
      const approvals = createMemoryApprovalStore();
      const t = spyTool("risky", 3);
      const a = attempt({
        provider: scriptedModel(["risky"]).provider,
        tools: [t],
        checkpoints: createMemoryCheckpointStore(),
        approvals,
        policy,
        clock: { now: T0 },
      });

      await a.loop.execute(a.ctx);

      expect(approvals.all()).toHaveLength(0);
      expect(t.run).not.toHaveBeenCalled();
    }
  });
});

describe("invariant 4: a retry meets the same row, and a conflicting row is never reused", () => {
  it("makes one row, with the first expiry, when the call is raised again later", async () => {
    const world = await pause();
    await world.checkpoints.clear({ workspaceId: WS, runId: RUN });
    world.clock.now = T0 + 30_000; // the retry runs later
    const again = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: world.tools,
      checkpoints: world.checkpoints,
      approvals: world.approvals,
      policy: allowAll,
      clock: world.clock,
    });

    await again.loop.execute(again.ctx);

    expect(world.approvals.all()).toHaveLength(1);
    const requested = again.rows.find((row) => row.type === "approval.requested");
    // The retry must not grant the call more time than its first request.
    expect(requested?.payload.expires_at).toBe(new Date(T0 + TTL_MS).toISOString());
  });

  it("makes one row per call when two calls of one step both need approval", async () => {
    const approvals = createMemoryApprovalStore();
    const risky = spyTool("risky", 3);
    const a = attempt({
      provider: scriptedModel(["risky", "risky"]).provider,
      tools: [risky],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: allowAll,
      clock: { now: T0 },
    });

    await a.loop.execute(a.ctx);

    // The loop pauses at the first escalated call, so exactly one row exists and it is for that call.
    expect(approvals.all().map((row) => row.approvalId)).toEqual([idOf(0)]);
    expect(risky.run).not.toHaveBeenCalled();
  });

  it("refuses a row with the same id bound to another payload: no event, no run, row untouched", async () => {
    const approvals = createMemoryApprovalStore();
    await approvals.create({
      workspaceId: WS,
      runId: RUN,
      agentId: AGENT,
      approvalId: idOf(0),
      action: "risky",
      payloadHash: "9".repeat(64),
      expiresAt: new Date(T0 + 5),
    });
    approvals.setStatus(idOf(0), "approved");
    const risky = spyTool("risky", 3);
    const a = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [risky],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: allowAll,
      clock: { now: T0 },
    });

    await expect(a.loop.execute(a.ctx)).rejects.toBeInstanceOf(ApprovalConflictError);

    expect(risky.run).not.toHaveBeenCalled();
    expect(types(a.rows)).not.toContain("approval.requested");
    expect(approvals.peek(idOf(0))).toMatchObject({
      status: "approved",
      payloadHash: "9".repeat(64),
    });
  });

  it("refuses a row with the same id that lives in another workspace", async () => {
    const approvals = createMemoryApprovalStore();
    await approvals.create({
      workspaceId: OTHER_WS,
      runId: RUN,
      agentId: AGENT,
      approvalId: idOf(0),
      action: "risky",
      payloadHash: "9".repeat(64),
      expiresAt: new Date(T0 + TTL_MS),
    });
    const risky = spyTool("risky", 3);
    const a = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [risky],
      checkpoints: createMemoryCheckpointStore(),
      approvals,
      policy: allowAll,
      clock: { now: T0 },
    });

    await expect(a.loop.execute(a.ctx)).rejects.toBeInstanceOf(ApprovalConflictError);
    expect(risky.run).not.toHaveBeenCalled();
  });

  it("stores the tool name and a payload hash only, never the tool input", async () => {
    const world = await pause();
    const [row] = world.approvals.all();

    expect(row?.action).toBe("risky");
    expect(row?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "action",
        "agentId",
        "approvalId",
        "expiresAt",
        "payloadHash",
        "runId",
        "status",
        "workspaceId",
      ].sort(),
    );
  });
});

describe("invariant 5: one approval.decided event per expiry, whoever gets there", () => {
  async function dueApprovals(count: number) {
    const approvals = createMemoryApprovalStore();
    for (let i = 0; i < count; i += 1) {
      await approvals.create({
        workspaceId: WS,
        runId: `00000000-0000-4000-8000-00000000d00${String(i)}`,
        agentId: AGENT,
        approvalId: `00000000-0000-4000-8000-00000000e00${String(i)}`,
        action: "risky",
        payloadHash: "a".repeat(64),
        expiresAt: new Date(T0 + i),
      });
    }
    return approvals;
  }

  it("writes one event and one wake-up per approval when two sweepers run at once", async () => {
    const approvals = await dueApprovals(4);
    const a = sweepOf(approvals, T0 + 1_000);
    const b = sweepOf(approvals, T0 + 1_000);

    const [x, y] = await Promise.all([a.run(), b.run()]);

    expect(x + y).toBe(4);
    const decided = decidedEvents([...a.rows, ...b.rows]);
    expect(decided).toHaveLength(4);
    expect(new Set(decided.map((row) => row.payload.approval_id)).size).toBe(4);
    expect(a.wake.mock.calls.length + b.wake.mock.calls.length).toBe(4);
  });

  it("writes one event when a sweeper slips in between the resume check's read and its expiry", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const sweep = sweepOf(world.approvals, T0 + TTL_MS);
    let isSwept = false;
    const racing = withOverrides(world.approvals, {
      get: async (ref) => {
        const snapshot = await world.approvals.get(ref);
        if (!isSwept && snapshot?.status === "pending") {
          isSwept = true;
          await sweep.run();
        }
        return snapshot;
      },
    });
    const b = resume(world, racing);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(decidedEvents([...b.rows, ...sweep.rows])).toHaveLength(1);
    expect(decidedEvents(sweep.rows)).toHaveLength(1); // the sweeper won, so the resume check wrote none
  });

  it("writes one event when the resume check wins and the sweeper runs after it", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const b = resume(world);
    await b.loop.execute(b.ctx);
    const sweep = sweepOf(world.approvals, T0 + TTL_MS * 2);

    await expect(sweep.run()).resolves.toBe(0);

    expect(decidedEvents([...b.rows, ...sweep.rows])).toHaveLength(1);
    expect(sweep.wake).not.toHaveBeenCalled();
  });

  it("writes one event when a sweeper and the resume check run concurrently", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS;
    const sweep = sweepOf(world.approvals, T0 + TTL_MS);
    const b = resume(world);

    await Promise.all([b.loop.execute(b.ctx), sweep.run()]);

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(decidedEvents([...b.rows, ...sweep.rows])).toHaveLength(1);
  });

  it("never expires an approval a human already decided, and the resumed call still does not run", async () => {
    const world = await pause();
    world.approvals.setStatus(idOf(0), "approved");
    world.clock.now = T0 + TTL_MS * 2;
    const sweep = sweepOf(world.approvals, T0 + TTL_MS * 2);

    await expect(sweep.run()).resolves.toBe(0);
    const b = resume(world);
    await b.loop.execute(b.ctx);

    expect(world.approvals.peek(idOf(0))?.status).toBe("approved");
    expect(sweep.rows).toHaveLength(0);
    expect(decidedEvents(b.rows)).toHaveLength(0);
    expect(world.risky.run).not.toHaveBeenCalled();
  });
});

describe("status transitions: the worker only moves pending to rejected", () => {
  it("leaves every status it did not write alone and writes nothing but pending or rejected", async () => {
    const world = await pause();
    const written = new Set<string>();
    const spying = withOverrides(world.approvals, {
      create: async (input) => {
        const stored = await world.approvals.create(input);
        written.add(stored.status);
        return stored;
      },
      expire: async (ref, now) => {
        const moved = await world.approvals.expire(ref, now);
        if (moved !== null) written.add(world.approvals.peek(ref.approvalId)?.status ?? "");
        return moved;
      },
    });
    world.clock.now = T0 + TTL_MS;
    const b = resume(world, spying);

    await b.loop.execute(b.ctx);

    expect([...written]).toEqual(["rejected"]);
    expect(world.approvals.peek(idOf(0))?.status).toBe("rejected");
  });

  it("does not move a denied row to rejected when it is past due", async () => {
    const world = await pause();
    world.approvals.setStatus(idOf(0), "denied");
    world.clock.now = T0 + TTL_MS * 3;
    const sweep = sweepOf(world.approvals, world.clock.now);

    await sweep.run();
    const b = resume(world);
    await b.loop.execute(b.ctx);

    expect(world.approvals.peek(idOf(0))?.status).toBe("denied");
    expect(failedCodes(b.rows)).toEqual(["approval_denied"]);
  });
});
