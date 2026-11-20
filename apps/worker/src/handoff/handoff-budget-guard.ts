import { worstCaseCostCents } from "@ago/shared";

import type { BudgetCallRequest, BudgetDecision, BudgetGuard } from "../budget/budget-guard.js";
import type { HandoffStore } from "./handoff-store.js";

/**
 * The handoff's own money cap, checked BEFORE each model call (AGO-81). It wraps the existing budget guard (AGO-40)
 * instead of adding a second reservation mechanism: for a run on a handoff task it first asks "could this call take the
 * task past the budget its sender passed on?", using the same worst-case estimate the guard holds (prompt estimated
 * high plus the whole output allowance). Only then does it delegate, so the agent's daily and the workspace's monthly
 * budgets still apply.
 *
 * Fails closed: a model with no price, or a store that cannot answer, is a refusal, never an allow.
 * An ordinary run (no handoff) goes straight to the wrapped guard.
 */
export function withHandoffBudget(
  guard: BudgetGuard,
  store: Pick<HandoffStore, "findByRun" | "spentCentsOnTask">,
  onStoreError?: (error: unknown) => void,
): BudgetGuard {
  const refuse = (
    reason: "handoff_budget_would_be_exceeded" | "model_not_priced" | "budget_check_failed",
    limit: number,
    used: number,
    estimateCents?: number,
  ): BudgetDecision => ({
    allowed: false,
    scope:
      reason === "model_not_priced"
        ? "pricing"
        : reason === "budget_check_failed"
          ? "ledger"
          : "run",
    reason,
    limit,
    used,
    ...(estimateCents === undefined ? {} : { estimateCents }),
  });

  return {
    async reserve(call: BudgetCallRequest): Promise<BudgetDecision> {
      if (call.runId === undefined) return guard.reserve(call);
      try {
        const handoff = await store.findByRun(call.workspaceId, call.runId);
        if (handoff === null) return await guard.reserve(call);
        const estimate =
          call.model === undefined
            ? null
            : worstCaseCostCents(call.model, call.inputCharacters, call.maxOutputTokens);
        if (estimate === null) return refuse("model_not_priced", 0, 0);
        const spent = await store.spentCentsOnTask(call.workspaceId, handoff.taskId);
        const limit = handoff.narrowed.budgetCents;
        if (spent + estimate > limit) {
          return refuse("handoff_budget_would_be_exceeded", limit, spent, estimate);
        }
      } catch (error) {
        try {
          onStoreError?.(error);
        } catch {
          // A broken reporter must not turn a refusal into an allow.
        }
        return refuse("budget_check_failed", 0, 0);
      }
      return guard.reserve(call);
    },
    settle: (reservation, model, usage) => guard.settle(reservation, model, usage),
    release: (reservation) => guard.release(reservation),
    chargeReserved: (reservation) => guard.chargeReserved(reservation),
  };
}
