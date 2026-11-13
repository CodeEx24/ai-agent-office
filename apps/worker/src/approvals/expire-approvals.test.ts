import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.js";
import { createMemoryApprovalStore } from "./approval-store.test-helpers.js";
import { expireDueApprovals } from "./expire-approvals.js";

import type { RunEventRow } from "../events/index.js";
import type { ResumeResult } from "../queue/run-control.js";

const WS = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000b1";
const RUN2 = "00000000-0000-4000-8000-0000000000b2";
const T0 = Date.parse("2026-11-13T00:00:00Z");
const HASH = "a".repeat(64);

function setup() {
  const approvals = createMemoryApprovalStore();
  const rows: RunEventRow[] = [];
  const resume = vi.fn((): Promise<ResumeResult> => Promise.resolve("resumed"));
  const clock = { now: T0 };
  const seed = (id: string, runId: string, ttlMs: number) =>
    approvals.create({
      workspaceId: WS,
      runId,
      agentId: AGENT,
      approvalId: id,
      action: "risky",
      payloadHash: HASH,
      expiresAt: new Date(T0 + ttlMs),
    });
  const sweep = (extra: { onError?: (e: unknown) => void; failEvents?: boolean } = {}) =>
    expireDueApprovals({
      approvals,
      events: {
        insert: (row) => {
          if (extra.failEvents === true) return Promise.reject(new Error("event store down"));
          rows.push(row);
          return Promise.resolve({ id: String(rows.length), seq: rows.length, created_at: "now" });
        },
      },
      control: { resumeAfterApprovalExpiry: resume },
      logger: createLogger({ level: "silent" }),
      now: () => clock.now,
      ...(extra.onError === undefined ? {} : { onError: extra.onError }),
    });
  return { approvals, rows, resume, clock, seed, sweep };
}

describe("approval expiry sweep (AGO-21)", () => {
  it("flips a due pending approval to rejected, records expired/timeout, and wakes the run", async () => {
    const { approvals, rows, resume, clock, seed, sweep } = setup();
    await seed("ap-1", RUN, 1_000);
    clock.now = T0 + 1_000;

    await expect(sweep()).resolves.toBe(1);

    expect(approvals.peek("ap-1")?.status).toBe("rejected");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: WS,
      run_id: RUN,
      type: "approval.decided",
      payload: {
        approval_id: "ap-1",
        outcome: "expired",
        decided_by: "timeout",
        payload_hash: HASH,
      },
    });
    expect(resume).toHaveBeenCalledWith({ workspaceId: WS, runId: RUN, approvalId: "ap-1" });
  });

  it("leaves an approval that is not due yet, and one a human already decided", async () => {
    const { approvals, rows, resume, clock, seed, sweep } = setup();
    await seed("not-due", RUN, 10_000);
    await seed("decided", RUN2, 1_000);
    approvals.setStatus("decided", "approved");
    clock.now = T0 + 5_000;

    await expect(sweep()).resolves.toBe(0);

    expect(approvals.peek("not-due")?.status).toBe("pending");
    expect(approvals.peek("decided")?.status).toBe("approved");
    expect(rows).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it("expires each approval once: a second pass does nothing", async () => {
    const { rows, resume, clock, seed, sweep } = setup();
    await seed("ap-1", RUN, 1_000);
    clock.now = T0 + 2_000;

    await sweep();
    await expect(sweep()).resolves.toBe(0);

    expect(rows).toHaveLength(1);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("still wakes the run, and reports it, when the decided event cannot be written", async () => {
    const { approvals, resume, clock, seed, sweep } = setup();
    await seed("ap-1", RUN, 1_000);
    clock.now = T0 + 2_000;
    const onError = vi.fn();

    await sweep({ failEvents: true, onError });

    expect(approvals.peek("ap-1")?.status).toBe("rejected");
    expect(resume).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps going with the other approvals when waking one run fails", async () => {
    const { rows, resume, clock, seed, sweep } = setup();
    await seed("ap-1", RUN, 1_000);
    await seed("ap-2", RUN2, 2_000);
    clock.now = T0 + 3_000;
    resume.mockRejectedValueOnce(new Error("queue down"));
    const onError = vi.fn();

    await expect(sweep({ onError })).resolves.toBe(2);

    expect(rows).toHaveLength(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });
});
