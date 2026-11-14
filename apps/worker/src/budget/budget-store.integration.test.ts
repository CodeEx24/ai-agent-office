// AGO-40 integration test: the real Postgres budget ledger against public.budgets_usage. It skips itself when the
// shared local Supabase stack is down. Run it inside the db lock, after a reset:
//   node scripts/db-lock.mjs acquire AGO-40 ... pnpm exec supabase db reset ... release AGO-40
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createBudgetGuard } from "./budget-guard.js";
import { createPgBudgetStore } from "./budget-store.js";

import type { Reservation } from "./budget-store.js";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1 from public.budgets_usage limit 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();

const AT = new Date("2026-11-14T10:00:00Z");
const DAY = "2026-11-14";
const MONTH = "2026-11-01";

describe.skipIf(!live)("Postgres budget ledger (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  const workspaces: string[] = [];

  /** A fresh workspace with one agent, so every test starts from an empty ledger. */
  async function fresh(dailyBudgetCents: number | null) {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    workspaces.push(workspaceId);
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-40 test')", [
      workspaceId,
    ]);
    await pool.query(
      "insert into public.agents (id, workspace_id, name, daily_budget_cents) values ($1, $2, 'a', $3)",
      [agentId, workspaceId, dailyBudgetCents],
    );
    return { workspaceId, agentId };
  }

  const used = async (workspaceId: string, agentId: string | null, start: string) =>
    (
      await pool.query<{ cost: string; tokens: string }>(
        `select cost_used_cents::text as cost, tokens_used::text as tokens from public.budgets_usage
          where workspace_id = $1 and agent_id is not distinct from $2 and period_start = $3`,
        [workspaceId, agentId, start],
      )
    ).rows[0];

  const setMonthlyBudget = (workspaceId: string, cents: number) =>
    pool.query(
      `insert into public.budgets_usage (workspace_id, agent_id, period_start, period_end, cost_budget_cents)
       values ($1, null, $2, '2026-12-01', $3)`,
      [workspaceId, MONTH, cents],
    );

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  });

  afterAll(async () => {
    if (workspaces.length > 0) {
      await pool.query("delete from public.workspaces where id = any($1::uuid[])", [workspaces]);
    }
    await pool.end();
  });

  it("holds the cents on the agent's daily row and the workspace's monthly row", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const result = await store.reserve({ workspaceId, agentId, cents: 30, at: AT });
    expect(result.ok).toBe(true);
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("30");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("30");
  });

  it("refuses a reserve that does not fit the agent's daily budget and holds nothing", async () => {
    const { workspaceId, agentId } = await fresh(50);
    const store = createPgBudgetStore(pool);
    expect((await store.reserve({ workspaceId, agentId, cents: 40, at: AT })).ok).toBe(true);
    const refused = await store.reserve({ workspaceId, agentId, cents: 11, at: AT });
    expect(refused).toEqual({ ok: false, scope: "agent_daily", limit: 50, used: 40 });
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("40");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("40");
  });

  it("refuses one call that alone is bigger than the budget, creating no row", async () => {
    const { workspaceId, agentId } = await fresh(50);
    const refused = await createPgBudgetStore(pool).reserve({
      workspaceId,
      agentId,
      cents: 51,
      at: AT,
    });
    expect(refused).toMatchObject({ ok: false, scope: "agent_daily", limit: 50 });
    expect(await used(workspaceId, agentId, DAY)).toBeUndefined();
  });

  it("refuses at the workspace's monthly budget and rolls the agent's daily cents back with it", async () => {
    const { workspaceId, agentId } = await fresh(1_000);
    await setMonthlyBudget(workspaceId, 60);
    const store = createPgBudgetStore(pool);
    expect((await store.reserve({ workspaceId, agentId, cents: 50, at: AT })).ok).toBe(true);
    const refused = await store.reserve({ workspaceId, agentId, cents: 20, at: AT });
    expect(refused).toEqual({ ok: false, scope: "workspace_monthly", limit: 60, used: 50 });
    // The agent's daily row must NOT keep the 20 cents the refused call tried to take.
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("50");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("50");
  });

  it("carries the owner's latest monthly budget into a month that has no row yet", async () => {
    const { workspaceId, agentId } = await fresh(1_000);
    await setMonthlyBudget(workspaceId, 25);
    const store = createPgBudgetStore(pool);
    const december = new Date("2026-12-03T09:00:00Z");
    expect((await store.reserve({ workspaceId, agentId, cents: 20, at: december })).ok).toBe(true);
    expect(await store.reserve({ workspaceId, agentId, cents: 6, at: december })).toMatchObject({
      ok: false,
      scope: "workspace_monthly",
      limit: 25,
    });
  });

  it("two concurrent reservations that together exceed the budget: exactly one wins", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const results = await Promise.all(
      [0, 1].map(() => store.reserve({ workspaceId, agentId, cents: 60, at: AT })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("60");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("60");
  });

  it("many concurrent reservations never spend more than the budget", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.reserve({ workspaceId, agentId, cents: 15, at: AT })),
    );
    // 100 / 15 = 6 fit
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("90");
  });

  it("settling a LOWER real cost releases the difference and adds the tokens to both rows", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const result = await store.reserve({ workspaceId, agentId, cents: 40, at: AT });
    if (!result.ok) throw new Error("expected the reserve to succeed");
    await store.settle(result.reservation, { cents: 12, tokens: 3_000 });
    expect(await used(workspaceId, agentId, DAY)).toEqual({ cost: "12", tokens: "3000" });
    expect(await used(workspaceId, null, MONTH)).toEqual({ cost: "12", tokens: "3000" });
  });

  it("settling a HIGHER real cost records the overrun on both rows", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const result = await store.reserve({ workspaceId, agentId, cents: 10, at: AT });
    if (!result.ok) throw new Error("expected the reserve to succeed");
    await store.settle(result.reservation, { cents: 25, tokens: 1 });
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("25");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("25");
  });

  it("release gives the cents back", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const store = createPgBudgetStore(pool);
    const result = await store.reserve({ workspaceId, agentId, cents: 40, at: AT });
    if (!result.ok) throw new Error("expected the reserve to succeed");
    await store.release(result.reservation);
    expect((await used(workspaceId, agentId, DAY))?.cost).toBe("0");
    expect((await used(workspaceId, null, MONTH))?.cost).toBe("0");
  });

  it("settling a reservation whose row is gone fails loudly instead of inventing a ledger row", async () => {
    const { workspaceId, agentId } = await fresh(100);
    const ghost: Reservation = {
      workspaceId,
      agentId,
      cents: 5,
      dayStart: DAY,
      monthStart: MONTH,
    };
    await expect(
      createPgBudgetStore(pool).settle(ghost, { cents: 5, tokens: 1 }),
    ).rejects.toThrow();
  });

  it("scopes by workspace: another workspace's spending does not count against this one", async () => {
    const a = await fresh(50);
    const b = await fresh(50);
    const store = createPgBudgetStore(pool);
    expect((await store.reserve({ ...a, cents: 50, at: AT })).ok).toBe(true);
    expect((await store.reserve({ ...b, cents: 50, at: AT })).ok).toBe(true);
  });

  it("an agent that does not exist is refused (error, so the guard denies)", async () => {
    const { workspaceId } = await fresh(100);
    await expect(
      createPgBudgetStore(pool).reserve({ workspaceId, agentId: randomUUID(), cents: 1, at: AT }),
    ).rejects.toThrow();
  });

  it("AC2: usage totals match the recorded model usage across many calls", async () => {
    const { workspaceId, agentId } = await fresh(1_000);
    const guard = createBudgetGuard({ store: createPgBudgetStore(pool), now: () => AT });
    const calls = [
      { inputTokens: 1_200, outputTokens: 300 },
      { inputTokens: 40_000, outputTokens: 2_000 },
      { inputTokens: 10, outputTokens: 5 },
    ];
    let cents = 0;
    let tokens = 0;
    for (const usage of calls) {
      const decision = await guard.reserve({
        workspaceId,
        agentId,
        model: "claude-haiku-5-5",
        inputCharacters: 4_000,
        maxOutputTokens: 4_096,
      });
      if (!decision.allowed) throw new Error("expected the reserve to be allowed");
      const settlement = await guard.settle(decision.reservation, "claude-haiku-5-5", usage);
      cents += settlement.costCents;
      tokens += usage.inputTokens + usage.outputTokens;
    }
    expect(await used(workspaceId, agentId, DAY)).toEqual({
      cost: String(cents),
      tokens: String(tokens),
    });
    expect(await used(workspaceId, null, MONTH)).toEqual({
      cost: String(cents),
      tokens: String(tokens),
    });
  });
});
