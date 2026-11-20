import { describe, expect, it } from "vitest";

import { applyRunRows, buildRunLog, createRunLogState, type RunEventRow } from "./run-log";
import {
  HASH,
  OTHER_RUN_ID,
  OTHER_WORKSPACE_ID,
  RUN_ID,
  WORKSPACE_ID,
  ev,
  stoppedByBudgetRows,
  usageEvent,
} from "./run-view-fixtures";

/** Functional acceptance tests for the run log fold (AGO-153): AC1 (live log rows) and AC2 (usage totals). */

const fresh = () => createRunLogState(WORKSPACE_ID, RUN_ID);
const view = (rows: readonly unknown[]) => buildRunLog(applyRunRows(fresh(), rows));

const MICROS_PER_CENT = 10_000;

describe("AC1: the log folds rows that arrive live", () => {
  it("shows nothing and reports a clean state when the run has no events", () => {
    const result = view([]);
    expect(result.timeline).toEqual([]);
    expect(result.shownEvents).toBe(0);
    expect(result.phase).toBeNull();
    expect(result.isCatchingUp).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costMicros: null,
      calls: 0,
      callsWithoutCost: 0,
    });
  });

  it("orders the log by seq when rows arrive out of order", () => {
    const rows = [
      ev(3, "message.emitted", { role: "agent", summary: "three" }),
      ev(1, "run.created", { agent_id: "15300000-0000-4000-8000-0000000000b1", task_id: null }),
      ev(2, "message.emitted", { role: "agent", summary: "two" }),
    ];
    const result = view(rows);
    expect(result.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(result.timeline.map((entry) => entry.detail)).toEqual([null, "two", "three"]);
  });

  it("holds back a row that is ahead of a missing one and shows it once the hole is filled", () => {
    const one = ev(1, "run.started");
    const two = ev(2, "message.emitted", { role: "agent", summary: "two" });
    const three = ev(3, "message.emitted", { role: "agent", summary: "three" });

    const gapped = applyRunRows(fresh(), [one, three]);
    const before = buildRunLog(gapped);
    expect(before.shownEvents).toBe(1);
    expect(before.isCatchingUp).toBe(true);
    expect(before.timeline.map((entry) => entry.detail)).not.toContain("three");
    expect(gapped.contiguousSeq).toBe(1);
    expect(gapped.highestSeq).toBe(3);

    const after = buildRunLog(applyRunRows(gapped, [two]));
    expect(after.shownEvents).toBe(3);
    expect(after.isCatchingUp).toBe(false);
    expect(after.timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("does not count a usage row that sits behind a hole in the totals", () => {
    const gapped = buildRunLog(
      applyRunRows(fresh(), [ev(1, "run.started"), usageEvent(3, 100, 50, 9)]),
    );
    expect(gapped.usage.calls).toBe(0);
    expect(gapped.usage.inputTokens).toBe(0);
    expect(gapped.usage.costMicros).toBeNull();
  });

  it("keeps one entry per seq and leaves the state untouched when the same rows are replayed", () => {
    const rows = [ev(1, "run.started"), ev(2, "message.emitted", { role: "agent", summary: "hi" })];
    const first = applyRunRows(fresh(), rows);
    const replayed = applyRunRows(first, [...rows, ...rows]);
    expect(replayed).toBe(first);
    expect(buildRunLog(replayed).timeline).toHaveLength(2);
  });

  it("keeps the first copy of a seq when a duplicate row arrives with different content", () => {
    const original = ev(1, "message.emitted", { role: "agent", summary: "original" });
    const imposter = {
      ...ev(1, "message.emitted", { role: "agent", summary: "imposter" }),
      id: "other-id",
    };
    const result = view([original, imposter]);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0]?.detail).toBe("original");
  });

  it("ignores rows of another run and of another workspace and counts them as rejected", () => {
    const foreignRun = ev(
      1,
      "message.emitted",
      { role: "agent", summary: "other run" },
      1,
      OTHER_RUN_ID,
    );
    const foreignWorkspace = ev(
      1,
      "message.emitted",
      { role: "agent", summary: "other workspace" },
      1,
      RUN_ID,
      OTHER_WORKSPACE_ID,
    );
    const state = applyRunRows(fresh(), [foreignRun, foreignWorkspace]);
    expect(state.rows.size).toBe(0);
    expect(state.rejected).toBe(2);
    expect(buildRunLog(state).timeline).toEqual([]);
  });

  it("drops malformed rows without throwing", () => {
    const good = ev(1, "run.started");
    const malformed: unknown[] = [
      null,
      "text",
      42,
      {},
      { ...good, seq: 0 },
      { ...good, seq: 1.5 },
      { ...good, seq: -3 },
      { ...good, seq: "2" },
      { ...good, id: undefined },
      { ...good, created_at: "not a date" },
    ];
    const state = applyRunRows(fresh(), [...malformed, good]);
    expect([...state.rows.keys()]).toEqual([1]);
    expect(state.rejected).toBe(malformed.length);
  });

  it("shows an unrecognised-event entry, not a crash, for an unknown type or an invalid payload", () => {
    const secret = ["sk", "live", "x".repeat(24)].join("-");
    const rows: RunEventRow[] = [
      ev(1, "run.started"),
      ev(2, "something.new_in_a_later_version", { a: 1 }),
      // Strict payloads: an extra key (a stray credential) makes the row unrecognised, and it is never shown.
      ev(3, "message.emitted", { role: "agent", summary: "hi", api_key: secret }),
      ev(4, "run.completed", { steps: "many" }),
    ];
    const result = view(rows);
    expect(result.unrecognised).toBe(3);
    expect(result.timeline).toHaveLength(4);
    expect(result.phase).toBe("running");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("cuts a hostile event type name in the unrecognised entry to 60 characters", () => {
    const result = view([ev(1, `<img src=x onerror=alert(1)>${"y".repeat(500)}`)]);
    expect(result.timeline[0]?.label.length).toBeLessThan(100);
  });
});

describe("AC2: cost and tokens equal the stored usage", () => {
  it("equals the sum of the stored budget.usage events of a run stopped by budget.exceeded", () => {
    const rows = stoppedByBudgetRows();
    const usagePayloads = rows
      .filter((row) => row.type === "budget.usage")
      .map(
        (row) => row.payload as { input_tokens: number; output_tokens: number; cost_cents: number },
      );
    // Expected values come from the stored rows, not from the fold under test.
    const expectedIn = usagePayloads.reduce((sum, p) => sum + p.input_tokens, 0);
    const expectedOut = usagePayloads.reduce((sum, p) => sum + p.output_tokens, 0);
    const expectedCents = usagePayloads.reduce((sum, p) => sum + p.cost_cents, 0);

    const result = view(rows);
    expect(result.usage.inputTokens).toBe(expectedIn);
    expect(result.usage.outputTokens).toBe(expectedOut);
    expect(result.usage.costMicros).toBe(expectedCents * MICROS_PER_CENT);
    expect(result.usage.calls).toBe(usagePayloads.length);
    expect(result.budgetStop).toMatchObject({ scope: "run", reason: "run_token_limit_reached" });
    expect(result.phase).toBe("stopped");
  });

  it("counts a replayed or out-of-order usage row exactly once", () => {
    const rows = stoppedByBudgetRows();
    const shuffled = [...rows.slice().reverse(), ...rows];
    expect(view(shuffled).usage).toEqual(view(rows).usage);
  });

  it("keeps a cost of zero as zero but a missing cost as null", () => {
    expect(view([usageEvent(1, 10, 5, 0)]).usage.costMicros).toBe(0);
    const unknown = view([usageEvent(1, 10, 5)]).usage;
    expect(unknown.costMicros).toBeNull();
    expect(unknown.callsWithoutCost).toBe(1);
  });

  it("sums only the calls that have a cost and counts the others as unreported", () => {
    const result = view([
      usageEvent(1, 100, 10, 4),
      usageEvent(2, 200, 20),
      usageEvent(3, 300, 30, 6),
    ]);
    expect(result.usage.inputTokens).toBe(600);
    expect(result.usage.outputTokens).toBe(60);
    expect(result.usage.costMicros).toBe(10 * MICROS_PER_CENT);
    expect(result.usage.calls).toBe(3);
    expect(result.usage.callsWithoutCost).toBe(1);
  });

  it("uses cost_micros when that is all the event carries", () => {
    const rows = [
      ev(1, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_micros: 1_234 }),
      ev(2, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_micros: 766 }),
    ];
    expect(view(rows).usage.costMicros).toBe(2_000);
  });

  it("does not mix usage of another run into the totals", () => {
    const own = usageEvent(1, 100, 10, 1);
    const foreign = ev(
      2,
      "budget.usage",
      { input_tokens: 9_999, output_tokens: 9_999, cost_cents: 99 },
      2,
      OTHER_RUN_ID,
    );
    expect(view([own, foreign]).usage).toMatchObject({ inputTokens: 100, calls: 1 });
  });

  it("does not let a usage event with a bad payload change the totals", () => {
    const bad = ev(2, "budget.usage", { input_tokens: -5, output_tokens: 1.5, cost_cents: "free" });
    const result = view([usageEvent(1, 100, 10, 1), bad]);
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, calls: 1 });
    expect(result.unrecognised).toBe(1);
  });
});

describe("hashes are never part of the view", () => {
  it("leaves tool, approval and loop hashes out of everything the screen can show", () => {
    const rows = [
      ev(1, "run.started"),
      ev(2, "tool_call.requested", {
        call_id: "c1",
        tool_name: "web.search",
        tier: 3,
        input_hash: HASH,
      }),
      ev(3, "approval.requested", {
        approval_id: "a1",
        call_id: "c1",
        payload_hash: HASH,
        tier: 3,
        expires_at: "2026-11-20T11:00:00.000Z",
      }),
      ev(4, "approval.decided", {
        approval_id: "a1",
        outcome: "approved",
        decided_by: "human",
        payload_hash: HASH,
      }),
      ev(5, "tool_call.completed", { call_id: "c1", duration_ms: 10, output_hash: HASH }),
      ev(6, "run.loop_detected", { tool_name: "web.search", call_hash: HASH, repeat_count: 3 }),
    ];
    const result = view(rows);
    expect(result.timeline).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain(HASH);
  });
});
