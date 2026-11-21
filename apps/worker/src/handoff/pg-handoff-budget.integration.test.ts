// AGO-81 round 3, independent acceptance tests against the real local Postgres: a hop is capped by the PARENT's
// REMAINING budget (parent budget minus the `budget.usage` spend of the runs on the parent task), `cost_cents`
// payload edge cases in both `spentCentsOnTask` and the SQL function, a hop-3 chain with an overspent middle task, and
// the round-3 nits in the function (the run's agent must be the task's assignee; a missing tier or mode is refused).
// Nothing is mocked. It skips itself when the local Supabase stack is down. Run it inside the db lock, after a reset:
//   node scripts/db-lock.mjs acquire AGO-81 ... pnpm exec supabase db reset ... release AGO-81
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore, createRunEventEmitter } from "../events/index.js";

import { acceptHandoff, createHandoff } from "./create-handoff.js";
import { createPgHandoffStore } from "./pg-handoff-store.js";

import type { HandoffRecord } from "./handoff-store.js";
import type { NarrowedGrant } from "@ago/shared/handoff";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select handoff_depth from public.tasks limit 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();
const FUNCTION_REFUSAL = "22023";
const NOT_FOUND = "P0002";

describe.skipIf(!live)("AGO-81 round 3 handoff budget (live database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  const ws = randomUUID();
  const user = randomUUID();
  const member = randomUUID();
  const id = () => randomUUID();
  const [A, B, C, D] = [id(), id(), id(), id()];
  const store = () => createPgHandoffStore(pool);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-81 budget')", [ws]);
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
      [user, `ago81-budget-${user}@example.test`],
    );
    await pool.query(
      "insert into public.members (id, workspace_id, user_id, role) values ($1, $2, $3, 'member')",
      [member, ws, user],
    );
    for (const [agentId, name] of [
      [A, "A"],
      [B, "B"],
      [C, "C"],
      [D, "D"],
    ] as const) {
      // The default daily budget is 500 cents, far above anything below, so only the handoff rules bind.
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, $3)", [
        agentId,
        ws,
        name,
      ]);
      await pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
         values ($1, $2, 'vault.read', 0, 'automatic')`,
        [ws, agentId],
      );
    }
    await pool.query(
      `insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled)
       values ($1, 'vault.read', 'Read vault', 0, 'workspace', 'automatic', true)
       on conflict (workspace_id, key) do update set tier = excluded.tier, enabled = true`,
      [ws],
    );
  });

  afterAll(async () => {
    await pool.query("delete from public.workspaces where id = $1", [ws]).catch(() => undefined);
    await pool.query("delete from auth.users where id = $1", [user]).catch(() => undefined);
    await pool.end();
  });

  // --- fixtures: each test builds its own tasks and runs -------------------------------------------------------
  async function rootRun(agentId: string): Promise<string> {
    const taskId = id();
    const runId = id();
    await pool.query(
      "insert into public.tasks (id, workspace_id, title, agent_id, created_by) values ($1, $2, 'root', $3, $4)",
      [taskId, ws, agentId, member],
    );
    await pool.query(
      "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, $3, $4)",
      [runId, ws, taskId, agentId],
    );
    return runId;
  }
  async function runOnTask(taskId: string, agentId: string): Promise<string> {
    const runId = id();
    await pool.query(
      "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, $3, $4)",
      [runId, ws, taskId, agentId],
    );
    return runId;
  }
  const emitterFor = (runId: string) =>
    createRunEventEmitter({ workspaceId: ws, runId, store: createPgRunEventStore(pool) });
  const hop = (runId: string, agentId: string, to: string, budgetCents?: number) =>
    createHandoff(
      { store: store(), emitter: emitterFor(runId) },
      { workspaceId: ws, runId, agentId },
      {
        to_agent_id: to,
        title: "t",
        ...(budgetCents === undefined ? {} : { requested: { budget_cents: budgetCents } }),
      },
    );
  /** Hand off with a budget and have the receiver run it. Returns the task and the receiver's accepting run. */
  async function handOver(runId: string, from: string, to: string, budgetCents: number) {
    const made = await hop(runId, from, to, budgetCents);
    if (!made.ok) throw new Error(`setup handoff failed: ${made.reason}`);
    const receiverRun = await runOnTask(made.taskId, to);
    const accepted = await acceptHandoff(
      { store: store(), emitter: emitterFor(receiverRun) },
      { workspaceId: ws, runId: receiverRun, agentId: to },
      made.taskId,
    );
    if (!accepted.ok) throw new Error(`setup accept failed: ${accepted.reason}`);
    return { taskId: made.taskId, runId: receiverRun };
  }
  const event = (runId: string, type: string, payload: Record<string, unknown>) =>
    pool.query(
      "insert into public.run_events (workspace_id, run_id, type, payload) values ($1, $2, $3, $4::jsonb)",
      [ws, runId, type, JSON.stringify(payload)],
    );
  /** A `budget.usage` event whose `cost_cents` is written as raw JSON, so any JSON type can be tried. */
  const costJson = (runId: string, rawJson: string) =>
    pool.query(
      `insert into public.run_events (workspace_id, run_id, type, payload)
       values ($1, $2, 'budget.usage', ('{"input_tokens":1,"output_tokens":1,"cost_cents":' || $3 || '}')::jsonb)`,
      [ws, runId, rawJson],
    );
  const cost = (runId: string, cents: number) => costJson(runId, String(cents));

  async function rawRecord(
    senderRun: string,
    to: string,
    budgetCents: number,
    capabilities: readonly NarrowedGrant[] = [],
  ): Promise<HandoffRecord> {
    const chain = await store().loadChainForRun(ws, senderRun);
    if (chain === null) throw new Error("setup: run has no chain");
    return {
      taskId: id(),
      workspaceId: ws,
      fromAgentId: chain.path[chain.path.length - 1] ?? "",
      senderRunId: senderRun,
      toAgentId: to,
      requesterMemberId: chain.requesterMemberId,
      path: [...chain.path, to],
      depth: chain.path.length,
      narrowed: { capabilities: [...capabilities], budgetCents, dataScope: [] },
      title: "raw",
      description: "",
      acceptedByRunId: null,
    };
  }
  async function outcomeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }
  const taskCount = async (taskId: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: number }>(
          "select count(*)::int as n from public.tasks where workspace_id = $1 and id = $2",
          [ws, taskId],
        )
      ).rows[0]?.n,
    );
  /** Ask the database function directly (no worker rule) to hand `budget` cents on from `senderRun`. */
  async function rawOutcome(senderRun: string, to: string, budget: number): Promise<string> {
    const record = await rawRecord(senderRun, to, budget);
    const outcome = await outcomeOf(store().insert(record));
    expect(await taskCount(record.taskId)).toBe(outcome === "ok" ? 1 : 0);
    return outcome;
  }

  // =============================================================================================================
  describe("AC2: hop 2 is capped by the parent's REMAINING budget (real budget.usage events)", () => {
    it("allows exactly the remaining budget and refuses one cent more (parent 100, spent 40)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 40);

      expect(await rawOutcome(parent.runId, C, 61)).toBe(FUNCTION_REFUSAL); // remaining + 1
      expect(await rawOutcome(parent.runId, C, 60)).toBe("ok"); // remaining exactly
    });

    it("the worker rule agrees: 61 is refused as widening, 60 is created with a 60 budget", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 40);

      expect(await hop(parent.runId, B, C, 61)).toEqual({ ok: false, reason: "widening_budget" });
      const made = await hop(parent.runId, B, C, 60);
      expect(made.ok).toBe(true);
      if (made.ok)
        expect((await store().findByTask(ws, made.taskId))?.narrowed.budgetCents).toBe(60);
    });

    it("with no budget requested the child gets exactly the parent's remaining budget", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 25);

      const made = await hop(parent.runId, B, C);
      expect(made.ok).toBe(true);
      if (made.ok)
        expect((await store().findByTask(ws, made.taskId))?.narrowed.budgetCents).toBe(75);
    });

    it("nothing spent: the full parent budget can pass on, one more cent cannot", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);

      expect(await rawOutcome(parent.runId, C, 101)).toBe(FUNCTION_REFUSAL);
      expect(await rawOutcome(parent.runId, C, 100)).toBe("ok");
    });

    it("spent equal to the budget: nothing can pass on (SQL refuses 1 cent, worker says no_budget)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 100);

      expect(await rawOutcome(parent.runId, C, 1)).toBe(FUNCTION_REFUSAL);
      expect(await hop(parent.runId, B, C)).toEqual({ ok: false, reason: "no_budget" });
      expect(await hop(parent.runId, B, C, 1)).toEqual({ ok: false, reason: "widening_budget" });
    });

    it("spent above the budget (overspent): the remaining is 0, never negative, so nothing can pass on", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 150);

      expect(await rawOutcome(parent.runId, C, 1)).toBe(FUNCTION_REFUSAL);
      expect(await hop(parent.runId, B, C)).toEqual({ ok: false, reason: "no_budget" });
    });

    it("spend from a second run on the same parent task also counts against the remaining budget", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const second = await runOnTask(parent.taskId, B);
      await cost(parent.runId, 30);
      await cost(second, 30);

      expect(await rawOutcome(second, C, 41)).toBe(FUNCTION_REFUSAL); // 100 - 60 = 40
      expect(await rawOutcome(second, C, 40)).toBe("ok");
    });

    it("spend on another task, and events that are not budget.usage, do not reduce the remaining budget", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const other = await handOver(await rootRun(A), A, B, 100);
      await cost(other.runId, 90);
      await event(parent.runId, "step.completed", { step: 1, outcome: "ok", cost_cents: 90 });

      expect(await rawOutcome(parent.runId, C, 100)).toBe("ok");
    });

    it("a hop cannot be refreshed by a later hop: spend after the child exists does not touch the child's budget", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const made = await hop(parent.runId, B, C, 60);
      expect(made.ok).toBe(true);
      await cost(parent.runId, 100); // the parent keeps spending after the child was created

      // The child's own record is unchanged (60); only NEW hops from the parent see the reduced remaining budget.
      if (made.ok)
        expect((await store().findByTask(ws, made.taskId))?.narrowed.budgetCents).toBe(60);
      expect(await rawOutcome(parent.runId, D, 1)).toBe(FUNCTION_REFUSAL);
    });
  });

  // =============================================================================================================
  describe("AC2: hop 3 and an overspent middle task", () => {
    it("hop 3 is capped by the middle task's remaining budget, not the root's", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, 100);
      await cost(first.runId, 40); // B has 60 left to pass on
      const second = await handOver(first.runId, B, C, 60);
      await cost(second.runId, 20); // C has 40 left

      expect(await rawOutcome(second.runId, D, 41)).toBe(FUNCTION_REFUSAL);
      expect(await rawOutcome(second.runId, D, 40)).toBe("ok");
    });

    it("an overspent middle task cannot hand anything on, even though the root budget was large", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, 400);
      const second = await handOver(first.runId, B, C, 50);
      await cost(second.runId, 70); // C overspent its 50

      expect(await rawOutcome(second.runId, D, 1)).toBe(FUNCTION_REFUSAL);
      expect(await hop(second.runId, C, D)).toEqual({ ok: false, reason: "no_budget" });
    });

    it("the hop that the middle task already made keeps working when the middle task later overspends", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, 100);
      const second = await handOver(first.runId, B, C, 60);
      const third = await handOver(second.runId, C, D, 30);
      await cost(first.runId, 500); // B overspends afterwards

      // D's own task is not changed by B's later spend, and D's own remaining budget is 30.
      expect((await store().findByTask(ws, third.taskId))?.narrowed.budgetCents).toBe(30);
      expect(await store().spentCentsOnTask(ws, third.taskId)).toBe(0);
    });
  });

  // =============================================================================================================
  describe("AC2: cost_cents edge payloads in spentCentsOnTask and in the SQL function", () => {
    const widths = (n: number) => "9".repeat(n);

    it.each([
      ["a 12-digit value counts in full", widths(12), 999_999_999_999],
      ["a 13-digit value counts as 0 and does not raise", widths(13), 0],
      ["a 20-digit value counts as 0 and does not raise", widths(20), 0],
      ["a negative number counts as 0", "-5", 0],
      ["a float counts as 0", "2.5", 0],
      // jsonb stores 1e3 as the number 1000, so it is read back as the whole number it is.
      ["an exponent number that is whole counts as its value", "1e3", 1_000],
      ["a numeric string counts as its digits", '"7"', 7],
      ["a non-numeric string counts as 0", '"abc"', 0],
      ["null counts as 0", "null", 0],
      ["a boolean counts as 0", "true", 0],
      ["an object counts as 0", '{"a":1}', 0],
      ["zero counts as 0", "0", 0],
      ["leading zeros are whole digits", '"007"', 7],
    ])("spentCentsOnTask: %s", async (_name, rawJson, expected) => {
      const root = await rootRun(A);
      const task = await handOver(root, A, B, 100);
      await costJson(task.runId, rawJson);

      expect(await store().spentCentsOnTask(ws, task.taskId)).toBe(expected);
    });

    it("spentCentsOnTask: a huge value next to a normal one neither raises nor hides the normal one", async () => {
      const root = await rootRun(A);
      const task = await handOver(root, A, B, 100);
      await cost(task.runId, 12);
      await costJson(task.runId, widths(30));
      await costJson(task.runId, "-4");
      await cost(task.runId, 8);

      expect(await store().spentCentsOnTask(ws, task.taskId)).toBe(20);
    });

    it.each([
      ["a 13-digit", widths(13)],
      ["a 40-digit", widths(40)],
      ["a negative", "-50"],
      ["a float", "2.5"],
      ["a non-numeric string", '"lots"'],
      ["a null", "null"],
    ])(
      "the SQL function ignores %s cost on the parent task: no 22003, the full 100 can still pass on",
      async (_name, rawJson) => {
        const root = await rootRun(A);
        const parent = await handOver(root, A, B, 100);
        await costJson(parent.runId, rawJson);

        expect(await rawOutcome(parent.runId, C, 100)).toBe("ok");
      },
    );

    it("the SQL function counts a 12-digit cost in full: the parent is overspent, nothing passes on", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await costJson(parent.runId, widths(12));

      expect(await rawOutcome(parent.runId, C, 1)).toBe(FUNCTION_REFUSAL);
    });

    it("the SQL function and spentCentsOnTask agree on a mix of payloads", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      for (const rawJson of [widths(13), "-5", "2.5", '"abc"', "10", '"5"', "null"]) {
        await costJson(parent.runId, rawJson);
      }
      // Counted: 10 and "5" -> 15. So 85 remain.
      expect(await store().spentCentsOnTask(ws, parent.taskId)).toBe(15);
      expect(await rawOutcome(parent.runId, C, 86)).toBe(FUNCTION_REFUSAL);
      expect(await rawOutcome(parent.runId, C, 85)).toBe("ok");
    });
  });

  // =============================================================================================================
  describe("AC2: round-3 nits in create_handoff_task", () => {
    it("refuses a run whose agent is not the task's assignee, and writes nothing", async () => {
      const root = await rootRun(A);
      // A run of agent B on A's task: B is not the assignee of that task.
      const taskId = (
        await pool.query<{ task_id: string }>(
          "select task_id from public.runs where workspace_id = $1 and id = $2",
          [ws, root],
        )
      ).rows[0]?.task_id;
      if (taskId === undefined) throw new Error("setup: no task");
      const foreignRun = await runOnTask(taskId, B);
      const record = { ...(await rawRecord(root, C, 10)), senderRunId: foreignRun };

      expect(await outcomeOf(store().insert(record))).toBe(NOT_FOUND);
      expect(await taskCount(record.taskId)).toBe(0);
    });

    it("accepts the assignee's own run (control for the assignee check)", async () => {
      const root = await rootRun(A);
      expect(await rawOutcome(root, B, 10)).toBe("ok");
    });

    it("refuses a capability entry with no tier, with 'bad handoff grants' and no row", async () => {
      const root = await rootRun(A);
      const noTier = { capabilityKey: "vault.read", mode: "automatic" } as unknown as NarrowedGrant;
      const record = await rawRecord(root, B, 10, [noTier]);
      const error = await store()
        .insert(record)
        .then(() => null)
        .catch((caught: unknown) => caught as { code?: string; message?: string });

      expect(error?.code).toBe(FUNCTION_REFUSAL);
      expect(error?.message).toContain("bad handoff grants");
      expect(await taskCount(record.taskId)).toBe(0);
    });

    it("refuses a capability entry with no mode, with 'bad handoff grants' and no row", async () => {
      const root = await rootRun(A);
      const noMode = { capabilityKey: "vault.read", tier: 0 } as unknown as NarrowedGrant;
      const record = await rawRecord(root, B, 10, [noMode]);
      const error = await store()
        .insert(record)
        .then(() => null)
        .catch((caught: unknown) => caught as { code?: string; message?: string });

      expect(error?.code).toBe(FUNCTION_REFUSAL);
      expect(error?.message).toContain("bad handoff grants");
      expect(await taskCount(record.taskId)).toBe(0);
    });

    it("a well-formed capability entry is still accepted (control for the coalesce change)", async () => {
      const root = await rootRun(A);
      const good: NarrowedGrant = { capabilityKey: "vault.read", tier: 0, mode: "automatic" };
      const record = await rawRecord(root, B, 10, [good]);

      expect(await outcomeOf(store().insert(record))).toBe("ok");
      expect(await taskCount(record.taskId)).toBe(1);
    });
  });
});
