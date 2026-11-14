import { effectiveDailyBudgetCents, effectiveMonthlyBudgetCents } from "@ago/shared";

/**
 * The budget ledger (AGO-40). One row of `public.budgets_usage` per agent per UTC day, and one workspace row
 * (`agent_id` null) per UTC month. Money is whole US cents; a reservation holds the worst-case cost of one model call
 * until the real cost is known.
 */

export interface BudgetScopeRef {
  readonly workspaceId: string;
  readonly agentId: string;
}

/** What one reserve holds: the agent's daily row and the workspace's monthly row it was taken from. */
export interface Reservation extends BudgetScopeRef {
  readonly cents: number;
  /** UTC date `YYYY-MM-DD` of the agent's daily row. */
  readonly dayStart: string;
  /** UTC date `YYYY-MM-DD` of the first day of the workspace's monthly row. */
  readonly monthStart: string;
}

/** Why a reserve was refused, with the numbers a human needs: the limit and what was already counted. */
export interface BudgetRefusal {
  readonly scope: "agent_daily" | "workspace_monthly";
  readonly limit: number;
  readonly used: number;
}

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | ({ readonly ok: false } & BudgetRefusal);

export interface BudgetStore {
  /**
   * Hold `cents` against BOTH the agent's daily budget and the workspace's monthly budget, or hold nothing. One
   * conditional write per row, so two runs cannot both take the last cent. Throws when it cannot tell (the guard
   * turns that into a refusal).
   */
  reserve(request: BudgetScopeRef & { cents: number; at: Date }): Promise<ReserveResult>;
  /**
   * Replace the reservation with what the call really cost: the ledger moves by `actual.cents - reservation.cents`
   * (down releases the difference, up records the overrun) and `actual.tokens` are added to the usage totals.
   */
  settle(reservation: Reservation, actual: { cents: number; tokens: number }): Promise<void>;
  /** Give a reservation back (the call was rejected before it could cost anything). */
  release(reservation: Reservation): Promise<void>;
}

/** The part of a `pg.PoolClient` this module uses. */
interface BudgetClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
  release(): void;
}
/** The part of `pg.Pool` this module uses, so a test can pass a stub. */
export interface BudgetDb {
  connect(): Promise<BudgetClient>;
}

export function utcDayStart(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function utcMonthStart(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

/**
 * Take `$4` cents from one ledger row if it still fits, creating the row when it is the first use of the period.
 * One statement: the insert path checks `$4 <= limit`, the conflict path re-checks the CURRENT row under its row
 * lock, so concurrent reservations queue up and each sees the other's cents. No row returned means refused.
 * `$5` is the limit; a budget the owner set on the row itself can only lower it.
 */
const reserveRowSql = (periodEnd: string): string => `
  insert into public.budgets_usage as b (workspace_id, agent_id, period_start, period_end, cost_used_cents)
  select $1::uuid, $2::uuid, $3::date, ${periodEnd}, $4::bigint
   where $4::bigint <= $5::bigint
  on conflict (workspace_id, agent_id, period_start) do update
    set cost_used_cents = b.cost_used_cents + $4::bigint
    where b.cost_used_cents + $4::bigint <= least($5::bigint, coalesce(b.cost_budget_cents, $5::bigint))
  returning cost_used_cents`;
const RESERVE_AGENT_SQL = reserveRowSql("($3::date + 1)");
const RESERVE_WORKSPACE_SQL = reserveRowSql("(($3::date + interval '1 month')::date)");

const READ_USED_SQL = `
  select cost_used_cents from public.budgets_usage
   where workspace_id = $1 and agent_id is not distinct from $2 and period_start = $3`;

/** Move one row by `$4` cents (never below zero) and add `$5` tokens. Exactly one row must match. */
const ADJUST_SQL = `
  update public.budgets_usage
     set cost_used_cents = greatest(0, cost_used_cents + $4::bigint),
         tokens_used = tokens_used + $5::bigint
   where workspace_id = $1 and agent_id is not distinct from $2 and period_start = $3
  returning 1`;

/** Internal: a refusal that must also undo what the transaction already wrote. */
class RefusedToHold extends Error {
  readonly refusal: BudgetRefusal;
  constructor(refusal: BudgetRefusal) {
    super("budget refused");
    this.refusal = refusal;
  }
}

function usedOf(rows: readonly unknown[]): number {
  const row = rows[0] as { cost_used_cents?: unknown } | undefined;
  return row === undefined ? 0 : Number(row.cost_used_cents);
}

/**
 * Postgres ledger. The worker's connection bypasses row level security, so every statement names `workspace_id`
 * with the agent (a composite key, never an agent id alone). Owner-set budgets are read, never written: usage
 * columns are runtime-only and agents have no way to reach this table.
 */
export function createPgBudgetStore(db: BudgetDb): BudgetStore {
  async function inTransaction<T>(work: (client: BudgetClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function adjust(
    reservation: Reservation,
    deltaCents: number,
    tokens: number,
  ): Promise<void> {
    const { workspaceId, agentId, dayStart, monthStart } = reservation;
    await inTransaction(async (client) => {
      const day = await client.query(ADJUST_SQL, [
        workspaceId,
        agentId,
        dayStart,
        deltaCents,
        tokens,
      ]);
      const month = await client.query(ADJUST_SQL, [
        workspaceId,
        null,
        monthStart,
        deltaCents,
        tokens,
      ]);
      if (day.rows.length !== 1 || month.rows.length !== 1) {
        throw new Error("budget ledger row missing while settling");
      }
    });
  }

  return {
    reserve({ workspaceId, agentId, cents, at }) {
      const dayStart = utcDayStart(at);
      const monthStart = utcMonthStart(at);
      return inTransaction(async (client): Promise<ReserveResult> => {
        const agent = await client.query(
          "select daily_budget_cents from public.agents where workspace_id = $1 and id = $2",
          [workspaceId, agentId],
        );
        const agentRow = agent.rows[0] as { daily_budget_cents?: unknown } | undefined;
        if (agentRow === undefined) throw new Error("agent not found for the budget check");
        const dailyLimit = effectiveDailyBudgetCents(
          typeof agentRow.daily_budget_cents === "number" ? agentRow.daily_budget_cents : null,
        );

        // The latest monthly budget an owner set carries forward to a month that has no row yet.
        const owner = await client.query(
          `select cost_budget_cents from public.budgets_usage
            where workspace_id = $1 and agent_id is null and cost_budget_cents is not null
            order by period_start desc limit 1`,
          [workspaceId],
        );
        const ownerRow = owner.rows[0] as { cost_budget_cents?: unknown } | undefined;
        const monthlyLimit = effectiveMonthlyBudgetCents(
          ownerRow === undefined ? null : Number(ownerRow.cost_budget_cents),
        );

        const day = await client.query(RESERVE_AGENT_SQL, [
          workspaceId,
          agentId,
          dayStart,
          cents,
          dailyLimit,
        ]);
        if (day.rows.length === 0) {
          const used = await client.query(READ_USED_SQL, [workspaceId, agentId, dayStart]);
          return { ok: false, scope: "agent_daily", limit: dailyLimit, used: usedOf(used.rows) };
        }

        const month = await client.query(RESERVE_WORKSPACE_SQL, [
          workspaceId,
          null,
          monthStart,
          cents,
          monthlyLimit,
        ]);
        if (month.rows.length === 0) {
          const used = await client.query(READ_USED_SQL, [workspaceId, null, monthStart]);
          // Thrown so the transaction rolls back: the agent's daily cents taken above must not stay held.
          throw new RefusedToHold({
            scope: "workspace_monthly",
            limit: monthlyLimit,
            used: usedOf(used.rows),
          });
        }
        return { ok: true, reservation: { workspaceId, agentId, cents, dayStart, monthStart } };
      }).catch((error: unknown): ReserveResult => {
        if (error instanceof RefusedToHold) return { ok: false, ...error.refusal };
        throw error;
      });
    },

    async settle(reservation, actual) {
      await adjust(reservation, actual.cents - reservation.cents, actual.tokens);
    },

    async release(reservation) {
      await adjust(reservation, -reservation.cents, 0);
    },
  };
}
