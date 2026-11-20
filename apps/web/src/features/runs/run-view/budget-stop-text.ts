import { formatCostMicros } from "../../approvals/approval-format";
import type { BudgetStopView } from "./run-log";

/**
 * Plain-words text for a run stopped by a budget (AGO-153). Pure, so the screen and its tests share one definition.
 * Units follow the AGO-40 ledger: the per-run budget counts tokens, the agent's daily and the workspace's monthly
 * budgets count cents. `pricing` and `ledger` are not limits (the check could not be made safely), so they have no
 * "used of limit" line.
 */

const MICROS_PER_CENT = 10_000;

export interface BudgetStopText {
  readonly title: string;
  /** "Used X of Y." or null when the stop is not about a limit. */
  readonly usage: string | null;
  /** What a person can do next. Never says an agent can change a budget: only people can. */
  readonly nextStep: string;
  /** True when the agent's own page is where a person manages its budget. */
  readonly linksToAgent: boolean;
}

export function describeBudgetStop(stop: BudgetStopView): BudgetStopText {
  const tokens = (count: number): string =>
    `${new Intl.NumberFormat("en-US").format(count)} tokens`;
  const money = (cents: number): string => formatCostMicros(cents * MICROS_PER_CENT);
  switch (stop.scope) {
    case "run":
      return {
        title: "This run was stopped: it reached its token budget.",
        usage: `Used ${tokens(stop.used)} of ${tokens(stop.limit)}.`,
        nextStep:
          "Next step: someone who manages this agent can raise its run budget on the agent page, then start a new run.",
        linksToAgent: true,
      };
    case "agent_daily":
      return {
        title: "This run was stopped: the agent reached its daily budget.",
        usage: `Used ${money(stop.used)} of ${money(stop.limit)} today.`,
        nextStep:
          "Next step: wait for the daily budget to reset (it resets at midnight UTC), or ask someone who manages this agent to raise it on the agent page.",
        linksToAgent: true,
      };
    case "workspace_monthly":
      return {
        title: "This run was stopped: the workspace reached its monthly budget.",
        usage: `Used ${money(stop.used)} of ${money(stop.limit)} this month.`,
        nextStep:
          "Next step: ask a workspace owner. Only an owner can change the monthly budget, and it can never go above the platform cap. It resets at the start of the next month (UTC).",
        linksToAgent: false,
      };
    default:
      return {
        title: "This run was stopped: its budget could not be checked safely.",
        usage: null,
        nextStep:
          "Next step: start a new run. If it stops again, tell a workspace owner so the agent's model and budget can be checked.",
        linksToAgent: false,
      };
  }
}
