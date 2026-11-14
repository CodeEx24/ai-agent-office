import { effectiveDailyBudgetCents, effectiveMonthlyBudgetCents } from "@ago/shared";

import { utcDayStart, utcMonthStart } from "./budget-store.js";

import type { BudgetStore, Reservation } from "./budget-store.js";

/**
 * Test only: an in-memory ledger that follows the same rules as the Postgres store (daily row per agent, monthly row
 * per workspace, all-or-nothing reserve, settle moves by the difference). The Postgres store itself is covered by
 * `budget-store.integration.test.ts` against the real database.
 */
export interface FakeBudgetStore extends BudgetStore {
  /** Cents counted on the agent's daily row. */
  dayUsed(): number;
  /** Cents counted on the workspace's monthly row. */
  monthUsed(): number;
  /** Tokens added to the usage totals. */
  tokensUsed(): number;
  readonly calls: { reserve: number; settle: number; release: number };
  /** Make the next call of this kind throw. */
  failNext(kind: "reserve" | "settle" | "release"): void;
}

export function createFakeBudgetStore(
  options: {
    readonly dailyBudgetCents?: number | null;
    readonly monthlyBudgetCents?: number | null;
    readonly dayUsedCents?: number;
    readonly monthUsedCents?: number;
  } = {},
): FakeBudgetStore {
  const dailyLimit = effectiveDailyBudgetCents(options.dailyBudgetCents);
  const monthlyLimit = effectiveMonthlyBudgetCents(options.monthlyBudgetCents);
  let day = options.dayUsedCents ?? 0;
  let month = options.monthUsedCents ?? 0;
  let tokens = 0;
  const failing = new Set<string>();
  const calls = { reserve: 0, settle: 0, release: 0 };

  const maybeFail = (kind: "reserve" | "settle" | "release"): void => {
    if (failing.delete(kind)) throw new Error(`fake ledger ${kind} failure`);
  };

  return {
    calls,
    dayUsed: () => day,
    monthUsed: () => month,
    tokensUsed: () => tokens,
    failNext: (kind) => {
      failing.add(kind);
    },
    reserve({ workspaceId, agentId, cents, at }) {
      calls.reserve += 1;
      maybeFail("reserve");
      if (day + cents > dailyLimit) {
        return Promise.resolve({ ok: false, scope: "agent_daily", limit: dailyLimit, used: day });
      }
      if (month + cents > monthlyLimit) {
        return Promise.resolve({
          ok: false,
          scope: "workspace_monthly",
          limit: monthlyLimit,
          used: month,
        });
      }
      day += cents;
      month += cents;
      const reservation: Reservation = {
        workspaceId,
        agentId,
        cents,
        dayStart: utcDayStart(at),
        monthStart: utcMonthStart(at),
      };
      return Promise.resolve({ ok: true, reservation });
    },
    settle(reservation, actual) {
      calls.settle += 1;
      maybeFail("settle");
      const delta = actual.cents - reservation.cents;
      day = Math.max(0, day + delta);
      month = Math.max(0, month + delta);
      tokens += actual.tokens;
      return Promise.resolve();
    },
    release(reservation) {
      calls.release += 1;
      maybeFail("release");
      day = Math.max(0, day - reservation.cents);
      month = Math.max(0, month - reservation.cents);
      return Promise.resolve();
    },
  };
}
