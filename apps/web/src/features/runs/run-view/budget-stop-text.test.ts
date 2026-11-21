import { describe, expect, it } from "vitest";

import { describeBudgetStop } from "./budget-stop-text";
import type { BudgetStopView } from "./run-log";

function stop(scope: string, used: number, limit: number): BudgetStopView {
  return { scope, used, limit } as unknown as BudgetStopView;
}

describe("describeBudgetStop (AGO-153)", () => {
  it("run scope: tokens, links to the agent, tells a person what to do", () => {
    const text = describeBudgetStop(stop("run", 4000, 4000));
    expect(text.title).toBe("This run was stopped: it reached its token budget.");
    expect(text.usage).toBe("Used 4,000 tokens of 4,000 tokens.");
    expect(text.nextStep).toMatch(/^Next step:/);
    expect(text.linksToAgent).toBe(true);
  });

  it("agent_daily scope: money, resets at midnight UTC, links to the agent", () => {
    const text = describeBudgetStop(stop("agent_daily", 500, 500));
    expect(text.title).toMatch(/daily budget/);
    expect(text.usage).toMatch(/today\.$/);
    expect(text.nextStep).toMatch(/midnight UTC/);
    expect(text.linksToAgent).toBe(true);
  });

  it("workspace_monthly scope: names the owner and does not link to the agent", () => {
    const text = describeBudgetStop(stop("workspace_monthly", 1000, 1000));
    expect(text.title).toMatch(/monthly budget/);
    expect(text.usage).toMatch(/this month\.$/);
    expect(text.nextStep).toMatch(/workspace owner/);
    expect(text.linksToAgent).toBe(false);
  });

  it("pricing and ledger stops are not limits: no usage line, no agent link", () => {
    for (const scope of ["pricing", "ledger"]) {
      const text = describeBudgetStop(stop(scope, 0, 0));
      expect(text.usage).toBeNull();
      expect(text.title).toMatch(/could not be checked safely/);
      expect(text.linksToAgent).toBe(false);
    }
  });
});
