// AGO-81 round 4, independent acceptance tests against the real local Postgres: a sender can no longer split its
// remaining budget across several child handoffs. What is covered: many small children summing up to exactly the limit
// (hop 1 and hop 2), spent + given at the boundary, zero-budget children, a child of another parent, hop 3, a child's
// own spend not handing budget back, an archived receiver, the two P0002 paths, and TWO CONCURRENT handoffs from one
// task made deterministic with two real connections (the first holds its transaction open, the second must wait on
// the parent row lock; then COMMIT must refuse the second and ROLLBACK must let it through).
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
const REFUSED = "22023";
const NOT_FOUND = "P0002";
const DAILY = 500; // the default daily budget of an agent: what hop 1 may pass on

describe.skipIf(!live)("AGO-81 round 4 budget split (live database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  const ws = randomUUID();
  const user = randomUUID();
  const member = randomUUID();
  const id = () => randomUUID();
  const [A, B, C, D, E] = [id(), id(), id(), id(), id()];
  const store = (db: pg.Pool | pg.Client = pool) => createPgHandoffStore(db);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-81 split')", [ws]);
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
      [user, `ago81-split-${user}@example.test`],
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
      [E, "E"],
    ] as const) {
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, $3)", [
        agentId,
        ws,
        name,
      ]);
    }
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
  const cost = (runId: string, cents: number) =>
    event(runId, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_cents: cents });

  async function rawRecord(
    senderRun: string,
    to: string,
    budgetCents: number,
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
      narrowed: { capabilities: [], budgetCents, dataScope: [] },
      title: "raw",
      description: "",
      acceptedByRunId: null,
    };
  }
  async function errorOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await promise;
      return { code: "ok", message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code ?? "error", message: e.message ?? String(error) };
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
  /** Ask the database function directly (no worker rule) to hand `budget` cents on; checks the row only exists on ok. */
  async function rawOutcome(senderRun: string, to: string, budget: number): Promise<string> {
    const record = await rawRecord(senderRun, to, budget);
    const outcome = (await errorOf(store().insert(record))).code;
    expect(await taskCount(record.taskId)).toBe(outcome === "ok" ? 1 : 0);
    return outcome;
  }
  const allocatedOn = async (runId: string): Promise<number> =>
    store().allocatedCentsOnRun(ws, runId);

  // =============================================================================================================
  describe("AC2: many small children cannot sum past what the sender holds", () => {
    it("hop 1: ten children of 50 use the whole daily 500 and the eleventh, even for 1 cent, is refused", async () => {
      const root = await rootRun(A);
      for (let i = 0; i < 10; i += 1) expect(await rawOutcome(root, B, 50)).toBe("ok");

      expect(await allocatedOn(root)).toBe(DAILY);
      expect(await rawOutcome(root, B, 1)).toBe(REFUSED);
      expect(await hop(root, A, B, 1)).toEqual({ ok: false, reason: "widening_budget" });
      expect(await hop(root, A, B)).toEqual({ ok: false, reason: "no_budget" });
    });

    it("hop 2: ten children of 10 use the whole remaining 100 and the eleventh is refused", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      for (let i = 0; i < 10; i += 1) expect(await rawOutcome(parent.runId, C, 10)).toBe("ok");

      expect(await rawOutcome(parent.runId, C, 1)).toBe(REFUSED);
      expect(await hop(parent.runId, B, C, 1)).toEqual({ ok: false, reason: "widening_budget" });
    });

    it("hop 2: the worker rule stops at the same place, with no database error (children of 30, 30, 30, then 11 left)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      for (let i = 0; i < 3; i += 1) expect((await hop(parent.runId, B, C, 30)).ok).toBe(true);

      expect(await hop(parent.runId, B, C, 11)).toEqual({ ok: false, reason: "widening_budget" });
      expect((await hop(parent.runId, B, C, 10)).ok).toBe(true);
      expect(await allocatedOn(parent.runId)).toBe(100);
    });
  });

  // =============================================================================================================
  describe("AC2: spent and given together, and the exact boundary", () => {
    it("hop 2: spent 30 by an unknown-outcome call plus a 30 child leaves 40; 41 is refused and 40 passes", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await event(parent.runId, "budget.exceeded", {
        scope: "ledger",
        reason: "call_outcome_unknown_charged",
        limit: 30,
        used: 30,
      });
      expect(await rawOutcome(parent.runId, C, 30)).toBe("ok");

      expect(await rawOutcome(parent.runId, D, 41)).toBe(REFUSED);
      expect(await rawOutcome(parent.runId, D, 40)).toBe("ok");
    });

    it("hop 2: spent by usage events and given to a child both reduce the remainder (spent 25, child 35, left 40)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      await cost(parent.runId, 25);
      expect(await rawOutcome(parent.runId, C, 35)).toBe("ok");

      expect(await hop(parent.runId, B, D, 41)).toEqual({ ok: false, reason: "widening_budget" });
      expect((await hop(parent.runId, B, D, 40)).ok).toBe(true);
    });

    it("hop 2: spending that already exceeds the budget leaves nothing to give, whatever was given before", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      expect(await rawOutcome(parent.runId, C, 20)).toBe("ok");
      await cost(parent.runId, 95); // 95 spent + 20 given = 115, more than the 100 held

      expect(await rawOutcome(parent.runId, D, 1)).toBe(REFUSED);
      expect(await rawOutcome(parent.runId, D, 0)).toBe("ok"); // a zero-budget handoff is still not wider
    });

    it("hop 2: a cost too large for the ledger counts as large even when a child was given before (nothing is left)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      expect(await rawOutcome(parent.runId, C, 10)).toBe("ok");
      await pool.query(
        `insert into public.run_events (workspace_id, run_id, type, payload)
         values ($1, $2, 'budget.usage', '{"cost_cents":99999999999999999999}'::jsonb)`,
        [ws, parent.runId],
      );

      expect(await rawOutcome(parent.runId, D, 1)).toBe(REFUSED);
    });

    it("hop 1: a child of 499 leaves exactly 1; 2 is refused and 1 passes", async () => {
      const root = await rootRun(A);
      expect(await rawOutcome(root, B, 499)).toBe("ok");

      expect(await rawOutcome(root, C, 2)).toBe(REFUSED);
      expect(await rawOutcome(root, C, 1)).toBe("ok");
      expect(await rawOutcome(root, D, 1)).toBe(REFUSED);
    });
  });

  // =============================================================================================================
  describe("AC2: zero-budget children and a child's own spend", () => {
    it("zero-budget children take nothing: after five of them the full remainder can still be given", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      for (let i = 0; i < 5; i += 1) expect(await rawOutcome(parent.runId, C, 0)).toBe("ok");

      expect(await allocatedOn(parent.runId)).toBe(0);
      expect(await rawOutcome(parent.runId, D, 101)).toBe(REFUSED);
      expect(await rawOutcome(parent.runId, D, 100)).toBe("ok");
    });

    it("a child that spends only part of its budget does not hand the unused part back to the sender", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const child = await handOver(parent.runId, B, C, 60);
      await cost(child.runId, 10); // the child used 10 of its 60

      expect(await allocatedOn(parent.runId)).toBe(60);
      expect(await rawOutcome(parent.runId, D, 41)).toBe(REFUSED); // 100 - 60 given
      expect(await rawOutcome(parent.runId, D, 40)).toBe("ok");
    });
  });

  // =============================================================================================================
  describe("AC2: a child of a different parent does not affect this parent", () => {
    it("hop 2: what one task gave away does not reduce another task's budget (two parents, same sender)", async () => {
      const rootOne = await rootRun(A);
      const rootTwo = await rootRun(A);
      const one = await handOver(rootOne, A, B, 100);
      const two = await handOver(rootTwo, A, B, 100);
      expect(await rawOutcome(one.runId, C, 100)).toBe("ok"); // task one gave away all of its 100

      expect(await allocatedOn(two.runId)).toBe(0);
      expect(await rawOutcome(two.runId, C, 101)).toBe(REFUSED);
      expect(await rawOutcome(two.runId, C, 100)).toBe("ok");
    });

    it("a child of a task does not count against its own parent's siblings (hop 1 allocation is per task, not per chain)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 200);
      expect(await rawOutcome(parent.runId, C, 150)).toBe("ok"); // B gave 150 from ITS task

      // A's task still holds only its own gift of 200 to B; B's gift to C is not counted on A's task.
      expect(await allocatedOn(root)).toBe(200);
      expect(await allocatedOn(parent.runId)).toBe(150);
    });

    it("documented limit: the hop-1 allocation is per task, so one agent with two root tasks can pass the daily budget on from each", async () => {
      // The ticket holds what ONE TASK handed to its children (docs/tickets/AGO-81.md, round 4). The daily budget is
      // read when the handoff is made. This test pins that behaviour so a change to it is a deliberate one.
      const rootOne = await rootRun(A);
      const rootTwo = await rootRun(A);

      expect(await rawOutcome(rootOne, B, DAILY)).toBe("ok");
      expect(await rawOutcome(rootTwo, B, DAILY)).toBe("ok");
    });
  });

  // =============================================================================================================
  describe("AC2: hop 3 split on the middle task", () => {
    it("the depth-3 hop is capped by the middle task's remaining budget minus what it already gave (two siblings to the same agent)", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, 100);
      await cost(first.runId, 40); // B holds 60
      const second = await handOver(first.runId, B, C, 60);
      await cost(second.runId, 10); // C holds 50
      expect(await rawOutcome(second.runId, D, 20)).toBe("ok");
      expect(await rawOutcome(second.runId, D, 20)).toBe("ok"); // a second sibling to the same agent is not a cycle

      expect(await rawOutcome(second.runId, D, 11)).toBe(REFUSED); // 50 - 40 = 10 left
      expect(await rawOutcome(second.runId, D, 10)).toBe("ok");
      expect(await rawOutcome(second.runId, D, 1)).toBe(REFUSED);
    });

    it("a fourth agent on the chain is refused as too deep, whatever budget is left", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, 100);
      const second = await handOver(first.runId, B, C, 80);
      const third = await handOver(second.runId, C, D, 50);

      expect(await rawOutcome(third.runId, E, 10)).toBe(REFUSED);
      expect(await hop(third.runId, D, E, 10)).toEqual({ ok: false, reason: "depth_exceeded" });
    });
  });

  // =============================================================================================================
  describe("AC2: archived receiver and the two not-found paths", () => {
    it("a handoff to an archived receiver is refused (P0002), leaves no row and takes no budget from the sender", async () => {
      const archived = id();
      await pool.query(
        "insert into public.agents (id, workspace_id, name, archived_at) values ($1, $2, 'gone', now())",
        [archived, ws],
      );
      const root = await rootRun(A);

      expect(await rawOutcome(root, archived, 300)).toBe(NOT_FOUND);
      expect(await allocatedOn(root)).toBe(0);
      expect(await rawOutcome(root, B, DAILY)).toBe("ok"); // the whole budget is still there
    });

    it("a receiver archived AFTER it was given budget still holds that budget against the sender", async () => {
      const late = id();
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'late')",
        [late, ws],
      );
      const root = await rootRun(A);
      expect(await rawOutcome(root, late, 300)).toBe("ok");
      await pool.query(
        "update public.agents set archived_at = now() where workspace_id = $1 and id = $2",
        [ws, late],
      );

      expect(await allocatedOn(root)).toBe(300);
      expect(await rawOutcome(root, B, 201)).toBe(REFUSED);
      expect(await rawOutcome(root, B, 200)).toBe("ok");
    });

    it("an archived sender is refused (P0002) before any budget is looked at", async () => {
      const sender = id();
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'sender')",
        [sender, ws],
      );
      const root = await rootRun(sender);
      await pool.query(
        "update public.agents set archived_at = now() where workspace_id = $1 and id = $2",
        [ws, sender],
      );

      expect(await rawOutcome(root, B, 1)).toBe(NOT_FOUND);
    });

    it("a run with no task is 'not found' (P0002) and the message names the run, not the assignee", async () => {
      const runId = id();
      await pool.query(
        "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, null, $3)",
        [runId, ws, A],
      );
      const record = { ...(await rawRecord(await rootRun(A), B, 1)), senderRunId: runId };

      const failure = await errorOf(store().insert(record));
      expect(failure.code).toBe(NOT_FOUND);
      expect(failure.message).toContain("run not found or has no task");
    });

    it("a run on another agent's task is refused with the assignee message (P0002), not the not-found one", async () => {
      const root = await rootRun(A);
      const otherTask = (
        await pool.query<{ task_id: string }>(
          "select task_id from public.runs where workspace_id = $1 and id = $2",
          [ws, root],
        )
      ).rows[0]?.task_id;
      const strangerRun = await runOnTask(otherTask ?? "", B); // B runs on A's task
      const record = { ...(await rawRecord(root, C, 1)), senderRunId: strangerRun };

      const failure = await errorOf(store().insert(record));
      expect(failure.code).toBe(NOT_FOUND);
      expect(failure.message).toContain("does not belong to the task's agent");
    });

    it("a run that does not exist at all is 'not found' (P0002)", async () => {
      const record = { ...(await rawRecord(await rootRun(A), B, 1)), senderRunId: id() };

      const failure = await errorOf(store().insert(record));
      expect(failure.code).toBe(NOT_FOUND);
      expect(failure.message).toContain("run not found or has no task");
    });
  });

  // =============================================================================================================
  describe("AC2: two concurrent handoffs from one task (two real connections, deterministic)", () => {
    async function open(): Promise<pg.Client> {
      const client = new pg.Client({ connectionString: DATABASE_URL });
      client.on("error", () => undefined);
      await client.connect();
      return client;
    }
    async function waitUntilBlocked(pid: number): Promise<void> {
      for (let i = 0; i < 200; i += 1) {
        const result = await pool.query<{ wait_event_type: string | null }>(
          "select wait_event_type from pg_stat_activity where pid = $1",
          [pid],
        );
        if (result.rows[0]?.wait_event_type === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the second handoff never waited on the parent task row lock");
    }

    /**
     * The first connection makes a handoff of `first` cents and keeps its transaction OPEN. The second asks for `second`
     * cents from the same task and must WAIT on the parent row lock. Then the first ends as `ending`. Returns what the
     * second one got and how many child rows exist at the end.
     */
    async function race(
      senderRun: string,
      first: number,
      second: number,
      ending: "COMMIT" | "ROLLBACK",
      receivers: readonly [string, string] = [B, C],
    ) {
      const one = await open();
      const two = await open();
      try {
        const firstRecord = await rawRecord(senderRun, receivers[0], first);
        const secondRecord = await rawRecord(senderRun, receivers[1], second);
        await one.query("BEGIN");
        await store(one).insert(firstRecord); // holds the parent row lock until the transaction ends

        const pidResult = await two.query<{ pid: number }>("select pg_backend_pid() as pid");
        const pending = errorOf(store(two).insert(secondRecord));
        await waitUntilBlocked(Number(pidResult.rows[0]?.pid));
        // Still waiting: the second call has not been answered while the first transaction is open.
        const stillWaiting = await Promise.race([
          pending.then(() => false),
          new Promise<boolean>((resolve) =>
            setTimeout(() => {
              resolve(true);
            }, 150),
          ),
        ]);
        await one.query(ending);
        const outcome = await pending;
        return {
          stillWaiting,
          outcome,
          firstExists: await taskCount(firstRecord.taskId),
          secondExists: await taskCount(secondRecord.taskId),
        };
      } finally {
        await one.query("ROLLBACK").catch(() => undefined);
        await one.end().catch(() => undefined);
        await two.end().catch(() => undefined);
      }
    }

    it("hop 1: when the first handoff commits, the second one (300 + 300 > 500) is refused and only the first exists", async () => {
      const root = await rootRun(A);
      const result = await race(root, 300, 300, "COMMIT");

      expect(result.stillWaiting).toBe(true);
      expect(result.outcome.code).toBe(REFUSED);
      expect(result.outcome.message).toContain("budget");
      expect([result.firstExists, result.secondExists]).toEqual([1, 0]);
    });

    it("hop 1: when the first handoff rolls back, the same second request goes through (nothing was held)", async () => {
      const root = await rootRun(A);
      const result = await race(root, 300, 300, "ROLLBACK");

      expect(result.stillWaiting).toBe(true);
      expect(result.outcome.code).toBe("ok");
      expect([result.firstExists, result.secondExists]).toEqual([0, 1]);
    });

    it("hop 2: when the first handoff commits, the second one (70 + 40 > 100) is refused and only the first exists", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const result = await race(parent.runId, 70, 40, "COMMIT", [C, D]);

      expect(result.stillWaiting).toBe(true);
      expect(result.outcome.code).toBe(REFUSED);
      expect([result.firstExists, result.secondExists]).toEqual([1, 0]);
    });

    it("hop 2: when the first handoff rolls back, the same second request goes through", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const result = await race(parent.runId, 70, 40, "ROLLBACK", [C, D]);

      expect(result.stillWaiting).toBe(true);
      expect(result.outcome.code).toBe("ok");
      expect([result.firstExists, result.secondExists]).toEqual([0, 1]);
    });

    it("hop 2: two requests that together fit both succeed, one after the other (40 + 60 of 100)", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const result = await race(parent.runId, 40, 60, "COMMIT", [C, D]);

      expect(result.outcome.code).toBe("ok");
      expect([result.firstExists, result.secondExists]).toEqual([1, 1]);
      expect(await allocatedOn(parent.runId)).toBe(100);
    });

    it("eight simultaneous handoffs of 30 from one hop-2 task: exactly three get through (90 of 100), none exceed it", async () => {
      const root = await rootRun(A);
      const parent = await handOver(root, A, B, 100);
      const clients = await Promise.all(Array.from({ length: 8 }, open));
      try {
        const records = await Promise.all(clients.map(() => rawRecord(parent.runId, C, 30)));
        const outcomes = await Promise.all(
          clients.map((client, index) => {
            const record = records[index];
            return errorOf(store(client).insert(record!));
          }),
        );

        expect(outcomes.filter((o) => o.code === "ok")).toHaveLength(3);
        expect(outcomes.filter((o) => o.code === REFUSED)).toHaveLength(5);
        expect(await allocatedOn(parent.runId)).toBe(90);
      } finally {
        await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
      }
    });
  });
});
