// AGO-58 AC2: a Reviewer's APPROVE does not satisfy a Tier 3 gate. A Reviewer agent (AGO-140, later) gives advice to
// the human who decides; the gate reads one thing only, an `approved` approval row bound to the call's payload hash.
// Fakes only: a scripted model, in-memory approval and checkpoint stores, a fake clock.
import { REVIEWER_VERDICT_IS_ADVISORY, satisfiesApprovalGate } from "@ago/shared";
import { describe, expect, it, vi } from "vitest";

import { approvalIdFor } from "../approvals/approval-id.js";
import { createMemoryApprovalStore } from "../approvals/approval-store.test-helpers.js";
import {
  RUN,
  T0,
  WS,
  allowAll,
  attempt,
  spyTool,
} from "./agent-loop.approvals.invariants.test-helpers.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.test-helpers.js";

import type { ApprovalStore } from "../approvals/approval-store.js";
import type { ModelProvider } from "./model-provider.js";

const REF = { workspaceId: WS, runId: RUN };
const usage = { inputTokens: 10, outputTokens: 5 };
const INPUT = { target: "production" };
const FIRST = approvalIdFor({ runId: RUN, step: 1, callId: "toolu_0" });

const model: ModelProvider = {
  complete: (request) => {
    const seenResult = JSON.stringify(request.messages).includes("status: ");
    return Promise.resolve(
      seenResult
        ? { text: "All done.", toolCalls: [], usage }
        : { text: "", toolCalls: [{ id: "toolu_0", name: "risky", input: INPUT }], usage },
    );
  },
};

async function pausedTier3Call() {
  const risky = spyTool("risky", 3);
  const checkpoints = createMemoryCheckpointStore();
  const approvals = createMemoryApprovalStore();
  const clock = { now: T0 };
  const first = attempt({
    provider: model,
    tools: [risky],
    checkpoints,
    approvals,
    policy: allowAll,
    clock,
  });
  const outcome = await first.loop.execute(first.ctx);
  expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
  return { risky, checkpoints, approvals, clock };
}

type World = Awaited<ReturnType<typeof pausedTier3Call>>;

async function resume(world: World, approvals: ApprovalStore = world.approvals) {
  const b = attempt({
    provider: model,
    tools: [world.risky],
    checkpoints: world.checkpoints,
    approvals,
    policy: allowAll,
    clock: world.clock,
  });
  return b.loop.execute(b.ctx);
}

/** What a Reviewer hands back. It is data about a call, never a write to the approval. */
const REVIEWER_APPROVE = {
  source: "reviewer_agent",
  verdict: "APPROVE",
  status: "approved",
} as const;

describe("AGO-58 AC2: a Reviewer APPROVE does not satisfy a Tier 3 gate", () => {
  it("names the Reviewer verdict as advisory, and only a human approval satisfies the gate predicate", () => {
    expect(REVIEWER_VERDICT_IS_ADVISORY).toBe(true);
    expect(
      satisfiesApprovalGate({ source: "reviewer_agent", status: REVIEWER_APPROVE.status }),
    ).toBe(false);
    expect(satisfiesApprovalGate({ source: "agent", status: "approved" })).toBe(false);
    expect(satisfiesApprovalGate({ source: "policy", status: "approved" })).toBe(false);
    expect(satisfiesApprovalGate({ source: "timeout", status: "approved" })).toBe(false);
    expect(satisfiesApprovalGate({ source: "human", status: "denied" })).toBe(false);
    expect(satisfiesApprovalGate({ source: "human", status: "approved" })).toBe(true);
  });

  it("leaves the approval pending and the call unrun after a Reviewer APPROVE, and stays paused on resume", async () => {
    const world = await pausedTier3Call();
    // The Reviewer's verdict exists, but nothing in the system turns it into an approval row.
    expect(REVIEWER_APPROVE.verdict).toBe("APPROVE");
    const consume = vi.fn((ref: Parameters<ApprovalStore["consume"]>[0], hash: string, now: Date) =>
      world.approvals.consume(ref, hash, now),
    );

    const outcome = await resume(world, { ...world.approvals, consume });

    expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.approvals.peek(FIRST)?.status).toBe("pending");
    expect(consume).not.toHaveBeenCalled();
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("does not run the call for a human approval bound to a different payload either", async () => {
    const world = await pausedTier3Call();
    world.approvals.setStatus(FIRST, "approved");
    // The call is edited after the request was raised: its hash no longer matches the stored one.
    const saved = structuredClone(world.checkpoints.peek(REF)) as unknown as {
      step: { calls: { input: unknown }[] };
    };
    const call = saved.step.calls[0];
    if (call === undefined) throw new Error("the checkpoint holds no call");
    call.input = { target: "somewhere else" };
    world.checkpoints.setRaw(REF, saved);

    const outcome = await resume(world);

    expect(outcome.end).not.toBe("paused");
    expect(world.risky.run).not.toHaveBeenCalled();
  });

  it("runs the call once only when a human approves the exact call, whatever a Reviewer said before", async () => {
    const world = await pausedTier3Call();
    expect(await resume(world)).toMatchObject({ end: "paused" });
    expect(world.risky.run).not.toHaveBeenCalled();

    world.approvals.setStatus(FIRST, "approved"); // the human decision

    expect((await resume(world)).end).toBe("completed");
    expect(world.risky.run).toHaveBeenCalledTimes(1);
    expect(world.risky.run).toHaveBeenCalledWith(INPUT, expect.anything());
  });
});
