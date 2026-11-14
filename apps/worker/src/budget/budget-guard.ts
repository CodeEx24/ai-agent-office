import { costCents, worstCaseCostCents } from "@ago/shared";

import type { BudgetStopReason, BudgetScope } from "@ago/shared";
import type { BudgetScopeRef, BudgetStore, Reservation } from "./budget-store.js";

/**
 * The budget check in front of every model call (AGO-40). It sits between the agent loop and the ledger and holds
 * the rules that make a stop a HARD stop:
 *
 * - the cost is checked BEFORE the call, on a worst case (the prompt, estimated high, plus the whole output allowance);
 * - a model with no price is denied, never treated as free;
 * - a ledger that cannot answer is a refusal, never an allow ("no check, no spend");
 * - the real cost replaces the reservation afterwards; a call that cost more than was reserved is reported so the
 *   loop can stop the run.
 *
 * The guard only decides. The loop writes the run events, so every refusal and stop is appended to `run_events`.
 */

export interface BudgetCallRequest extends BudgetScopeRef {
  /** The model that will serve the call, as the provider reports it. Missing or unknown means denied. */
  readonly model: string | undefined;
  /** Size of everything sent to the model: system text, messages and tool definitions. */
  readonly inputCharacters: number;
  /** The output allowance of the call (`maxOutputTokens`). */
  readonly maxOutputTokens: number;
}

export type BudgetDecision =
  | { readonly allowed: true; readonly reservation: Reservation; readonly estimateCents: number }
  | {
      readonly allowed: false;
      readonly scope: BudgetScope;
      readonly reason: BudgetStopReason;
      readonly limit: number;
      readonly used: number;
      readonly estimateCents?: number;
    };

export interface BudgetSettlement {
  /** What the call cost, rounded up: exactly what the usage event reports and the ledger holds. */
  readonly costCents: number;
  /** The call cost more than was reserved for it. */
  readonly overran: boolean;
  /** The ledger could not record the real cost. The run must stop: spend that is not counted is not limited. */
  readonly ledgerFailed: boolean;
}

export interface BudgetGuard {
  /** Never throws: every failure is a refusal. */
  reserve(call: BudgetCallRequest): Promise<BudgetDecision>;
  /** Never throws. `model` and `usage` are the call's real ones. */
  settle(
    reservation: Reservation,
    model: string,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
  ): Promise<BudgetSettlement>;
  /** Give the reservation back after a call that was rejected without cost. Never throws. */
  release(reservation: Reservation): Promise<void>;
  /**
   * Count the reservation as spent, at the reserved worst case, after a call whose outcome is unknown (a dropped
   * connection after the request was sent, a malformed answer, an abort): it may have been billed. Never throws.
   */
  chargeReserved(reservation: Reservation): Promise<void>;
}

export interface BudgetGuardOptions {
  readonly store: BudgetStore;
  /** Where store failures are reported (the guard still refuses). */
  readonly onStoreError?: (error: unknown) => void;
  /** Tests inject a clock. */
  readonly now?: () => Date;
}

export function createBudgetGuard(options: BudgetGuardOptions): BudgetGuard {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    try {
      options.onStoreError?.(error);
    } catch {
      // A broken reporter must not turn a refusal into an allow.
    }
  };

  return {
    async reserve(call) {
      const model = call.model;
      const estimate =
        model === undefined
          ? null
          : worstCaseCostCents(model, call.inputCharacters, call.maxOutputTokens);
      if (estimate === null) {
        return { allowed: false, scope: "pricing", reason: "model_not_priced", limit: 0, used: 0 };
      }
      try {
        const result = await store.reserve({
          workspaceId: call.workspaceId,
          agentId: call.agentId,
          cents: estimate,
          at: now(),
        });
        if (result.ok) {
          return { allowed: true, reservation: result.reservation, estimateCents: estimate };
        }
        return {
          allowed: false,
          scope: result.scope,
          reason:
            result.scope === "agent_daily"
              ? "agent_daily_limit_would_be_exceeded"
              : "workspace_monthly_limit_would_be_exceeded",
          limit: result.limit,
          used: result.used,
          estimateCents: estimate,
        };
      } catch (error) {
        report(error);
        return {
          allowed: false,
          scope: "ledger",
          reason: "budget_check_failed",
          limit: 0,
          used: 0,
          estimateCents: estimate,
        };
      }
    },

    async settle(reservation, model, usage) {
      // The model was priced when the reservation was taken; a missing price now would be a code change in between.
      // Charge the reservation (the worst case) rather than nothing.
      const real = costCents(model, usage) ?? reservation.cents;
      const tokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
      try {
        await store.settle(reservation, { cents: real, tokens });
        return { costCents: real, overran: real > reservation.cents, ledgerFailed: false };
      } catch (error) {
        report(error);
        return { costCents: real, overran: real > reservation.cents, ledgerFailed: true };
      }
    },

    async release(reservation) {
      try {
        await store.release(reservation);
      } catch (error) {
        // Cents stay held: the ledger over-counts, which is the safe side.
        report(error);
      }
    },

    async chargeReserved(reservation) {
      try {
        // Tokens are unknown for an unanswered call, so only the money is recorded; the hold becomes spend.
        await store.settle(reservation, { cents: reservation.cents, tokens: 0 });
      } catch (error) {
        // The hold stays in the ledger either way: it over-counts, which is the safe side.
        report(error);
      }
    },
  };
}
