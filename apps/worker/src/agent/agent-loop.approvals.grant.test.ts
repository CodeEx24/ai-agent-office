// AGO-47: an approval grants only the exact call it was given for, once, and in time. Fakes only: a scripted
// model, in-memory approval and checkpoint stores and a fake clock. The real consume race (separate database
// connections) is in approvals/approval-store.integration.test.ts.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { approvalIdFor } from "../approvals/approval-id.js";
import { createMemoryApprovalStore } from "../approvals/approval-store.test-helpers.js";
import { approvalPayloadHash } from "../approvals/payload-hash.js";
import { uniqueStepCallIds } from "./agent-loop.js";
import {
  RUN,
  T0,
  TTL_MS,
  WS,
  allowAll,
  attempt,
  denyAll,
  escalateAll,
  failedCodes,
  spyTool,
  types,
  type SpyTool,
} from "./agent-loop.approvals.invariants.test-helpers.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.test-helpers.js";

import type { ApprovalStore } from "../approvals/approval-store.js";
import type { ModelProvider } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";

const REF = { workspaceId: WS, runId: RUN };
const usage = { inputTokens: 10, outputTokens: 5 };
const INPUT = { a: 1, b: { x: 1, y: 2 } };
const idFor = (callId: string, step = 1): string => approvalIdFor({ runId: RUN, step, callId });
const FIRST = idFor("toolu_0");

interface ScriptedCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Makes the given calls on the first request, then answers with text once a tool result is in the history. */
function modelCalling(calls: readonly ScriptedCall[]): ModelProvider {
  return {
    complete: (request) => {
      const seenResult = JSON.stringify(request.messages).includes("status: ");
      return Promise.resolve(
        seenResult || calls.length === 0
          ? { text: "All done.", toolCalls: [], usage }
          : { text: "", toolCalls: calls.map((call) => ({ ...call })), usage },
      );
    },
  };
}

/** First attempt: the model makes its calls, the tier 3 one pauses the run for approval. */
async function pause(
  options: {
    tools?: readonly SpyTool[];
    calls?: readonly ScriptedCall[];
    policy?: PolicyHook;
  } = {},
) {
  const risky = spyTool("risky", 3);
  const tools = options.tools ?? [risky];
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const clock = { now: T0 };
  const first = attempt({
    provider: modelCalling(options.calls ?? [{ id: "toolu_0", name: "risky", input: INPUT }]),
    tools,
    checkpoints,
    approvals,
    policy: options.policy ?? allowAll,
    clock,
  });
  const outcome = await first.loop.execute(first.ctx);
  return { risky, tools, checkpoints, approvals, clock, outcome };
}

type World = Awaited<ReturnType<typeof pause>>;

function resume(world: World, over: { approvals?: ApprovalStore; policy?: PolicyHook } = {}) {
  return attempt({
    provider: modelCalling([]),
    tools: world.tools,
    checkpoints: world.checkpoints,
    approvals: over.approvals ?? world.approvals,
    policy: over.policy ?? allowAll,
    clock: world.clock,
  });
}

/** A spy on `consume` that still calls the real in-memory store. */
const spyConsume = (world: World) =>
  vi.fn((ref: Parameters<ApprovalStore["consume"]>[0], hash: string, now: Date) =>
    world.approvals.consume(ref, hash, now),
  );

/** Stand in for a human approving in the inbox. */
const approve = (world: World, approvalId = FIRST): void => {
  world.approvals.setStatus(approvalId, "approved");
};

/** The saved run state, to put back later: it models a crash right after the grant was taken. */
const snapshot = (world: World): unknown => structuredClone(world.checkpoints.peek(REF));
const restore = (world: World, saved: unknown): void => {
  world.checkpoints.setRaw(REF, structuredClone(saved));
};

/** Change the saved call after the approval was requested, leaving its stored `payload_hash` as it was. */
function editAwaitingCall(
  world: World,
  edit: (call: { name: string; input: unknown }) => void,
): void {
  const state = structuredClone(world.checkpoints.peek(REF)) as unknown as {
    step: { calls: { name: string; input: unknown }[] };
  };
  const call = state.step.calls[0];
  if (call === undefined) throw new Error("the checkpoint holds no call");
  edit(call);
  world.checkpoints.setRaw(REF, state);
}

async function run(world: World, over: Parameters<typeof resume>[1] = {}) {
  const b = resume(world, over);
  const outcome = await b.loop.execute(b.ctx);
  return { ...b, outcome };
}

describe("AGO-47: an approved call runs, once", () => {
  it("runs the call the approval is bound to, exactly once, and consumes the approval", async () => {
    const world = await pause();
    expect(world.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.risky.run).not.toHaveBeenCalled();
    approve(world);

    const b = await run(world);

    expect(b.outcome.end).toBe("completed");
    expect(world.risky.run).toHaveBeenCalledTimes(1);
    expect(world.risky.run).toHaveBeenCalledWith(INPUT, expect.anything());
    expect(failedCodes(b.rows)).toEqual([]);
    expect(types(b.rows)).toEqual(
      expect.arrayContaining(["tool_call.started", "tool_call.completed"]),
    );
    const row = world.approvals.peek(FIRST);
    expect(row?.consumedAt).not.toBeNull();
    // The worker never rewrites a human's decision.
    expect(row?.status).toBe("approved");
  });

  it("stays paused, and consumes nothing, while the approval is still pending", async () => {
    const world = await pause();
    const consume = spyConsume(world);
    const b = await run(world, { approvals: { ...world.approvals, consume } });

    expect(b.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(consume).not.toHaveBeenCalled();
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it.each(["denied", "rejected"])("never consumes or runs a %s approval", async (status) => {
    const world = await pause();
    world.approvals.setStatus(FIRST, status);
    const consume = spyConsume(world);

    await run(world, { approvals: { ...world.approvals, consume } });

    expect(consume).not.toHaveBeenCalled();
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();
  });

  it("never lets the loop write approved or denied itself", async () => {
    const world = await pause();
    await run(world);
    await run(world);

    expect(world.approvals.all().map((row) => row.status)).toEqual(["pending"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });
});

describe("AGO-47 AC1: a changed payload is rejected", () => {
  it("refuses a changed argument value, runs nothing and leaves the approval unused", async () => {
    const world = await pause();
    approve(world);
    editAwaitingCall(world, (call) => {
      call.input = { ...INPUT, a: 2 };
    });

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();
  });

  it("refuses a changed nested value", async () => {
    const world = await pause();
    approve(world);
    editAwaitingCall(world, (call) => {
      call.input = { a: 1, b: { x: 1, y: 3 } };
    });

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("refuses an added argument", async () => {
    const world = await pause();
    approve(world);
    editAwaitingCall(world, (call) => {
      call.input = { ...INPUT, extra: true };
    });

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("refuses the same arguments under a different tool name", async () => {
    const other = spyTool("other", 3);
    const risky = spyTool("risky", 3);
    const world = await pause({ tools: [risky, other] });
    approve(world);
    editAwaitingCall(world, (call) => {
      call.name = "other";
    });

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(risky.run).not.toHaveBeenCalled();
    expect(other.run).not.toHaveBeenCalled();
  });

  it("does not trust a hash it is handed: a rewritten checkpoint hash does not make an edited call pass", async () => {
    const world = await pause();
    approve(world);
    // Someone edits the saved call and also rewrites the checkpoint's stored hash to match the edited call.
    const changed = { ...INPUT, a: 99 };
    const state = structuredClone(world.checkpoints.peek(REF)) as unknown as {
      step: { calls: { input: unknown; payload_hash?: string }[] };
    };
    const call = state.step.calls[0];
    if (call === undefined) throw new Error("the checkpoint holds no call");
    call.input = changed;
    call.payload_hash = approvalPayloadHash("risky", changed);
    world.checkpoints.setRaw(REF, state);

    const b = await run(world);

    // The approval row still holds the hash of what the human saw, and that is what every check compares to.
    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();
  });

  it("gives the same hash, so still runs, when only the key order of the saved call changed", async () => {
    const world = await pause();
    approve(world);
    editAwaitingCall(world, (call) => {
      call.input = { b: { y: 2, x: 1 }, a: 1 };
    });

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual([]);
    expect(world.risky.run).toHaveBeenCalledTimes(1);
  });
});

describe("AGO-47 AC2: a used approval cannot be reused", () => {
  it("refuses a second use of the same approval and does not run the tool again", async () => {
    const world = await pause();
    approve(world);
    const awaiting = snapshot(world);
    await run(world);
    expect(world.risky.run).toHaveBeenCalledTimes(1);

    // The same call is awaiting approval again (a crash after the grant, before the result was saved).
    restore(world, awaiting);
    const again = await run(world);

    expect(failedCodes(again.rows)).toEqual(["approval_already_used"]);
    expect(world.risky.run).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed tool's approval spent: a second attempt is refused", async () => {
    const world = await pause();
    approve(world);
    world.risky.run.mockRejectedValueOnce(new Error("boom"));
    const awaiting = snapshot(world);

    const first = await run(world);
    expect(failedCodes(first.rows)).toEqual(["tool_error"]);
    expect(world.approvals.peek(FIRST)?.consumedAt).not.toBeNull();

    restore(world, awaiting);
    const second = await run(world);

    expect(failedCodes(second.rows)).toEqual(["approval_already_used"]);
    expect(world.risky.run).toHaveBeenCalledTimes(1);
  });

  it("loses cleanly when another worker takes the grant between the screen and the consume", async () => {
    const world = await pause();
    approve(world);
    const racing: ApprovalStore = {
      ...world.approvals,
      consume: async (ref, hash, now) => {
        await world.approvals.consume(ref, hash, now);
        return null;
      },
    };

    const b = await run(world, { approvals: racing });

    expect(failedCodes(b.rows)).toEqual(["approval_already_used"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("gives exactly one winner when two consumes race on the in-memory store", async () => {
    const world = await pause();
    approve(world);
    const ref = { ...REF, approvalId: FIRST };
    const hash = approvalPayloadHash("risky", INPUT);

    const results = await Promise.all([
      world.approvals.consume(ref, hash, new Date(T0)),
      world.approvals.consume(ref, hash, new Date(T0)),
    ]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });
});

describe("AGO-47 AC3: approvals expire at their limit", () => {
  it("refuses an approved row at exactly its limit, and runs it one millisecond before", async () => {
    const late = await pause();
    approve(late);
    late.clock.now = T0 + TTL_MS;
    const refused = await run(late);

    expect(failedCodes(refused.rows)).toEqual(["approval_expired"]);
    expect(late.risky.run).not.toHaveBeenCalled();
    expect(late.approvals.peek(FIRST)?.consumedAt).toBeNull();

    const early = await pause();
    approve(early);
    early.clock.now = T0 + TTL_MS - 1;
    const granted = await run(early);

    expect(failedCodes(granted.rows)).toEqual([]);
    expect(early.risky.run).toHaveBeenCalledTimes(1);
  });

  it("still denies a pending request past its limit (timeout means deny)", async () => {
    const world = await pause();
    world.clock.now = T0 + TTL_MS * 2;

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("refuses when the limit passes between the screen and the consume", async () => {
    const world = await pause();
    approve(world);
    const slow: ApprovalStore = {
      ...world.approvals,
      consume: (ref, hash) => {
        world.clock.now = T0 + TTL_MS + 1_000;
        return world.approvals.consume(ref, hash, new Date(world.clock.now));
      },
    };

    const b = await run(world, { approvals: slow });

    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();
  });
});

describe("AGO-47: policy still wins, and the order is policy, consume, execute", () => {
  it("does not run, or consume, a granted call the policy now denies", async () => {
    const world = await pause();
    approve(world);
    const awaiting = snapshot(world);

    const denied = await run(world, { policy: denyAll });

    expect(failedCodes(denied.rows)).toEqual(["policy_denied"]);
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();

    // Untouched, so it is still a valid grant if the policy allows the call again.
    restore(world, awaiting);
    const allowed = await run(world);
    expect(failedCodes(allowed.rows)).toEqual([]);
    expect(world.risky.run).toHaveBeenCalledTimes(1);
  });

  it("does not consume the approval when the saved input is invalid for the tool", async () => {
    const strict: SpyTool = { ...spyTool("risky", 3), inputSchema: z.object({ need: z.string() }) };
    const world = await pause({ tools: [strict] });
    approve(world);

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["invalid_input"]);
    expect(strict.run).not.toHaveBeenCalled();
    expect(world.approvals.peek(FIRST)?.consumedAt).toBeNull();
  });

  it("asks the policy first, then consumes, then runs the tool", async () => {
    const world = await pause();
    approve(world);
    const order: string[] = [];
    const policy: PolicyHook = {
      check: () => {
        order.push("policy");
        return Promise.resolve({ decision: "allow", reasonCode: "test_allow" });
      },
    };
    const approvals: ApprovalStore = {
      ...world.approvals,
      consume: (ref, hash, now) => {
        order.push("consume");
        return world.approvals.consume(ref, hash, now);
      },
    };
    world.risky.run.mockImplementation(() => {
      order.push("run");
      return "ok";
    });

    await run(world, { policy, approvals });

    expect(order).toEqual(["policy", "consume", "run"]);
  });

  it("consumes the grant even when the policy now says plain allow for a tier below 3", async () => {
    const safe = spyTool("safe", 2);
    const world = await pause({
      tools: [safe],
      calls: [{ id: "toolu_0", name: "safe", input: INPUT }],
      policy: escalateAll,
    });
    expect(world.outcome).toMatchObject({ pauseReason: "approval_required" });
    approve(world);
    const awaiting = snapshot(world);

    const b = await run(world, { policy: allowAll });

    expect(failedCodes(b.rows)).toEqual([]);
    expect(safe.run).toHaveBeenCalledTimes(1);
    expect(world.approvals.peek(FIRST)?.consumedAt).not.toBeNull();

    restore(world, awaiting);
    const again = await run(world, { policy: allowAll });
    expect(failedCodes(again.rows)).toEqual(["approval_already_used"]);
    expect(safe.run).toHaveBeenCalledTimes(1);
  });

  it("never runs a granted call when no approval store is configured", async () => {
    const world = await pause();
    approve(world);
    const b = attempt({
      provider: modelCalling([]),
      tools: world.tools,
      checkpoints: world.checkpoints,
      approvals: undefined,
      policy: allowAll,
      clock: world.clock,
    });

    await b.loop.execute(b.ctx);

    expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });
});

describe("AGO-47: the call's index is part of the binding", () => {
  const twins: readonly ScriptedCall[] = [
    { id: "dup", name: "risky", input: { n: 1 } },
    { id: "dup", name: "risky", input: { n: 1 } },
  ];

  it("gives two calls with the same id and payload their own approvals, and one cannot grant the other", async () => {
    const world = await pause({ calls: twins });
    expect(world.approvals.all()).toHaveLength(1);
    expect(world.checkpoints.peek(REF)?.step?.calls.map((call) => call.call_id)).toEqual([
      "dup",
      "call_1_1",
    ]);

    // Approve call 0 only. It runs; call 1 asks for its own approval instead of using call 0's.
    approve(world, idFor("dup"));
    const second = await run(world);

    expect(world.risky.run).toHaveBeenCalledTimes(1);
    expect(second.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.approvals.all().map((row) => row.approvalId)).toEqual([
      idFor("dup"),
      idFor("call_1_1"),
    ]);
    expect(world.approvals.peek(idFor("call_1_1"))?.status).toBe("pending");

    // Nothing more runs until a human answers call 1.
    const third = await run(world);
    expect(third.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.risky.run).toHaveBeenCalledTimes(1);
  });

  it("does not let call index 0's approval run a different payload", async () => {
    const world = await pause({
      calls: [
        { id: "dup", name: "risky", input: { n: 1 } },
        { id: "dup", name: "risky", input: { n: 2 } },
      ],
    });
    approve(world, idFor("dup"));
    const state = structuredClone(world.checkpoints.peek(REF)) as unknown as {
      step: { calls: { input: unknown }[] };
    };
    const [zero, one] = state.step.calls;
    if (zero === undefined || one === undefined) throw new Error("expected two saved calls");
    // Point the awaiting call at call 1's payload: index 0's approval must not cover it.
    zero.input = one.input;
    world.checkpoints.setRaw(REF, state);

    const b = await run(world);

    expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
    expect(world.risky.run).not.toHaveBeenCalled();
  });
});

describe("uniqueStepCallIds", () => {
  it("keeps distinct valid ids as they are", () => {
    expect(uniqueStepCallIds(3, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("gives a repeated id its index-based id", () => {
    expect(uniqueStepCallIds(1, ["x", "x"])).toEqual(["x", "call_1_1"]);
  });

  it("makes the index-based id unique when a model-chosen id took it", () => {
    expect(uniqueStepCallIds(1, ["x", "x", "call_1_1"])).toEqual(["x", "call_1_1", "call_1_2"]);
    expect(uniqueStepCallIds(1, ["call_1_1", "call_1_1"])).toEqual(["call_1_1", "call_1_1_2"]);
  });

  it("replaces an invalid id with its index-based id", () => {
    expect(uniqueStepCallIds(2, ["bad id!", "", "ok"])).toEqual(["call_2_0", "call_2_1", "ok"]);
  });

  it("never returns two equal ids, whatever the model sent", () => {
    const sent = ["a", "a", "a", "call_4_1", "call_4_1", "", "", "call_4_6", "x y", "x y"];
    const ids = uniqueStepCallIds(4, sent);

    expect(new Set(ids).size).toBe(sent.length);
  });
});
