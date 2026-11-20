import { describe, expect, it } from "vitest";

import { applyRunRows, buildRunLog, createRunLogState } from "./run-log";
import {
  HASH,
  LEDGER_CENTS_BY_CALL,
  OTHER_RUN_ID,
  OTHER_WORKSPACE_ID,
  RUN_ID,
  WORKSPACE_ID,
  ev,
  stoppedByBudgetRows,
  usageEvent,
} from "./run-view-fixtures";

const fresh = () => createRunLogState(WORKSPACE_ID, RUN_ID);

describe("run log fold", () => {
  it("builds steps, tool calls, phase and timeline from stored events", () => {
    const view = buildRunLog(applyRunRows(fresh(), stoppedByBudgetRows()));
    expect(view.phase).toBe("stopped");
    expect(view.steps.map((s) => [s.step, s.outcome])).toEqual([
      [1, "ok"],
      [2, null],
    ]);
    expect(view.toolCalls).toEqual([
      expect.objectContaining({
        callId: "c1",
        toolName: "web.search",
        tier: 1,
        status: "completed",
        durationMs: 1_250,
        policy: { decision: "allow", reasonCode: "tier_1_allowed" },
      }),
    ]);
    expect(view.timeline).toHaveLength(13);
    expect(view.shownEvents).toBe(13);
  });

  it("never carries tool call hashes into the view", () => {
    const view = buildRunLog(applyRunRows(fresh(), stoppedByBudgetRows()));
    expect(JSON.stringify(view)).not.toContain(HASH);
  });
});

describe("cost and tokens equal the stored usage (AC2)", () => {
  it("sums the budget.usage events, equal to the cents the worker settled in the ledger", () => {
    const view = buildRunLog(applyRunRows(fresh(), stoppedByBudgetRows()));
    const ledgerCents = LEDGER_CENTS_BY_CALL.reduce((a, b) => a + b, 0);
    expect(view.usage.inputTokens).toBe(3_200);
    expect(view.usage.outputTokens).toBe(800);
    expect(view.usage.calls).toBe(2);
    expect(view.usage.costMicros).toBe(ledgerCents * 10_000);
  });

  it("is the same for a run stopped by budget.exceeded, and shows the stop", () => {
    const view = buildRunLog(applyRunRows(fresh(), stoppedByBudgetRows()));
    expect(view.budgetStop).toEqual({
      scope: "run",
      reason: "run_token_limit_reached",
      limit: 4_000,
      used: 4_000,
    });
    expect(view.phase).toBe("stopped");
    expect(view.usage.costMicros).toBe(19 * 10_000);
  });

  it("prefers cost_micros when present and reports a missing cost as null, not zero", () => {
    const micros = ev(2, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_micros: 1_234 });
    expect(
      buildRunLog(applyRunRows(fresh(), [ev(1, "run.started"), micros])).usage.costMicros,
    ).toBe(1_234);
    const none = buildRunLog(applyRunRows(fresh(), [ev(1, "run.started"), usageEvent(2, 5, 6)]));
    expect(none.usage.costMicros).toBeNull();
    expect(none.usage.callsWithoutCost).toBe(1);
    expect(none.usage.inputTokens).toBe(5);
  });

  it("counts a usage event once even when its row is applied twice", () => {
    const rows = stoppedByBudgetRows();
    const view = buildRunLog(applyRunRows(applyRunRows(fresh(), rows), rows));
    expect(view.usage.calls).toBe(2);
    expect(view.usage.costMicros).toBe(190_000);
  });
});

describe("ordering, duplicates and gaps", () => {
  it("ignores duplicates and rows out of order", () => {
    const rows = stoppedByBudgetRows();
    const state = applyRunRows(fresh(), [...rows].reverse());
    expect(state.rows.size).toBe(13);
    expect(state.contiguousSeq).toBe(13);
    expect(buildRunLog(state).timeline.map((e) => e.seq)).toEqual(rows.map((r) => r.seq));
  });

  it("returns the same state object when nothing changed", () => {
    const state = applyRunRows(fresh(), stoppedByBudgetRows());
    expect(applyRunRows(state, stoppedByBudgetRows())).toBe(state);
  });

  it("shows only the contiguous prefix while a row is missing, then everything once it arrives", () => {
    const rows = stoppedByBudgetRows();
    const withHole = applyRunRows(
      fresh(),
      rows.filter((r) => r.seq !== 5),
    );
    expect(withHole.contiguousSeq).toBe(4);
    expect(withHole.highestSeq).toBe(13);
    const partial = buildRunLog(withHole);
    expect(partial.shownEvents).toBe(4);
    expect(partial.isCatchingUp).toBe(true);
    expect(partial.usage.calls).toBe(1);

    const filled = buildRunLog(
      applyRunRows(
        withHole,
        rows.filter((r) => r.seq === 5),
      ),
    );
    expect(filled.shownEvents).toBe(13);
    expect(filled.isCatchingUp).toBe(false);
    expect(filled.usage.calls).toBe(2);
  });

  it("rejects rows of another run or another workspace and malformed rows", () => {
    const state = applyRunRows(fresh(), [
      ev(1, "run.created", { agent_id: "x", task_id: null }, 1, OTHER_RUN_ID),
      ev(1, "run.started", {}, 1, RUN_ID, OTHER_WORKSPACE_ID),
      { nope: true },
      null,
      { ...ev(1, "run.started"), seq: 0 },
    ]);
    expect(state.rows.size).toBe(0);
    expect(state.rejected).toBe(5);
    expect(buildRunLog(state).timeline).toEqual([]);
  });
});

describe("unrecognised and hostile content", () => {
  it("shows an unknown or invalid event as a visible line and keeps going", () => {
    const view = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "run.started"),
        ev(2, "future.thing", { x: 1 }),
        ev(3, "step.started", { step: "not a number" }),
        ev(4, "run.completed", { steps: 1 }),
      ]),
    );
    expect(view.unrecognised).toBe(2);
    expect(view.timeline.map((e) => e.label)).toContain("Unrecognised event (future.thing)");
    expect(view.phase).toBe("completed");
  });

  it("carries agent text verbatim as data (the components render it as plain text)", () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold** [x](javascript:alert(1))';
    const view = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "run.started"),
        ev(2, "message.emitted", { role: "agent", summary: hostile }),
      ]),
    );
    expect(view.timeline.at(-1)?.detail).toBe(hostile);
  });
});

describe("phases", () => {
  it("follows pause, resume, failure and completion", () => {
    const paused = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "run.started"),
        ev(2, "run.paused", { requested_by: "human", reason: "user_pause" }),
      ]),
    );
    expect(paused.phase).toBe("paused");
    expect(paused.pausedAt).not.toBeNull();

    const resumed = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "run.started"),
        ev(2, "run.paused", { requested_by: "human", reason: "user_pause" }),
        ev(3, "run.resumed", { resumed_by: "human" }),
      ]),
    );
    expect(resumed.phase).toBe("running");
    expect(resumed.pausedAt).toBeNull();

    const failed = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "run.started"),
        ev(2, "run.failed", { reason: "model_error", message: "boom" }),
      ]),
    );
    expect(failed.phase).toBe("failed");
    expect(failed.failure).toEqual({ reason: "model_error", message: "boom" });
  });

  it("marks a denied call and a call waiting for approval", () => {
    const view = buildRunLog(
      applyRunRows(fresh(), [
        ev(1, "tool_call.requested", { call_id: "a", tool_name: "x", tier: 3, input_hash: HASH }),
        ev(2, "policy.decision", {
          call_id: "a",
          decision: "needs_approval",
          tier: 3,
          reason_code: "t3",
        }),
        ev(3, "tool_call.requested", { call_id: "b", tool_name: "y", tier: 4, input_hash: HASH }),
        ev(4, "policy.decision", { call_id: "b", decision: "deny", tier: 4, reason_code: "t4" }),
      ]),
    );
    expect(view.toolCalls.map((c) => c.status)).toEqual(["awaiting_approval", "denied"]);
  });
});
