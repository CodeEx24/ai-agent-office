import { describe, expect, it } from "vitest";

import { describeBudgetStop } from "./budget-stop-text";
import { applyRunRows, buildRunLog, createRunLogState, type BudgetStopView } from "./run-log";
import { RUN_ID, WORKSPACE_ID, ev } from "./run-view-fixtures";

const stop = (scope: string, used: number, limit: number): BudgetStopView => ({
  scope,
  reason: "x",
  used,
  limit,
});

describe("describeBudgetStop units (AGO-153 round 2)", () => {
  it("run scope counts tokens with thousands separators", () => {
    expect(describeBudgetStop(stop("run", 1_234_567, 2_000_000)).usage).toBe(
      "Used 1,234,567 tokens of 2,000,000 tokens.",
    );
  });

  it("daily and monthly scopes convert cents to dollars", () => {
    expect(describeBudgetStop(stop("agent_daily", 250, 500)).usage).toBe(
      "Used $2.50 of $5.00 today.",
    );
    expect(describeBudgetStop(stop("workspace_monthly", 10_000, 20_000)).usage).toBe(
      "Used $100.00 of $200.00 this month.",
    );
  });

  it("a stop with no limit shows a zero spend as $0.00, not as not reported", () => {
    expect(describeBudgetStop(stop("agent_daily", 0, 0)).usage).toBe("Used $0.00 of $0.00 today.");
  });

  it("only the run and agent daily scopes link to the agent", () => {
    const linked = ["run", "agent_daily", "workspace_monthly", "pricing", "ledger"].map(
      (scope) => [scope, describeBudgetStop(stop(scope, 1, 2)).linksToAgent] as const,
    );
    expect(linked).toEqual([
      ["run", true],
      ["agent_daily", true],
      ["workspace_monthly", false],
      ["pricing", false],
      ["ledger", false],
    ]);
  });

  it("every scope has a next step that starts with Next step: and gives a person the action", () => {
    for (const scope of ["run", "agent_daily", "workspace_monthly", "pricing", "ledger"]) {
      const text = describeBudgetStop(stop(scope, 1, 2));
      expect(text.nextStep).toMatch(/^Next step: /);
      expect(text.nextStep).toMatch(/someone who manages|workspace owner|start a new run/);
    }
  });
});

describe("cost_cents is preferred over cost_micros (AGO-153 round 2)", () => {
  const view = (rows: unknown[]) =>
    buildRunLog(applyRunRows(createRunLogState(WORKSPACE_ID, RUN_ID), rows));

  it("uses cost_cents when an event carries both", () => {
    const row = ev(1, "budget.usage", {
      input_tokens: 1,
      output_tokens: 1,
      cost_cents: 7,
      cost_micros: 999,
    });
    expect(view([row]).usage.costMicros).toBe(70_000);
  });

  it("falls back to cost_micros only when cost_cents is absent", () => {
    const rows = [
      ev(1, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_cents: 3 }),
      ev(2, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_micros: 5_000 }),
    ];
    expect(view(rows).usage.costMicros).toBe(35_000);
  });

  it("treats cost_cents of 0 as a real zero even when cost_micros is also present", () => {
    const row = ev(1, "budget.usage", {
      input_tokens: 1,
      output_tokens: 1,
      cost_cents: 0,
      cost_micros: 500,
    });
    const usage = view([row]).usage;
    expect(usage.costMicros).toBe(0);
    expect(usage.callsWithoutCost).toBe(0);
  });
});
