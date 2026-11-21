// AGO-81 round 5, independent acceptance tests against the real local Postgres: a handoff task's OWN spend limit is its
// narrowed budget minus what it gave to child handoffs, so one grant of 100 cents totals at most 100 across the task's
// own spend and its children (never 200 or 300). The real store (`createPgHandoffStore`), the real budget guard wrapper
// (`withHandoffBudget`) and the real policy hook (`createHandoffPolicyHook`) are used on rows made by the real
// `createHandoff` / `acceptHandoff`. Only the wrapped AGO-40 guard is a stub that allows (the daily and monthly budgets
// are not under test).
// It skips itself when the local Supabase stack is down. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-81 ... release AGO-81
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore, createRunEventEmitter } from "../events/index.js";
import {
  HANDOFF_BUDGET_EXHAUSTED,
  createHandoffPolicyHook,
} from "../policy/handoff-policy-hook.js";

import { acceptHandoff, createHandoff } from "./create-handoff.js";
import { withHandoffBudget } from "./handoff-budget-guard.js";
import { createPgHandoffStore } from "./pg-handoff-store.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
import type { BudgetDecision, BudgetGuard } from "../budget/budget-guard.js";
import type { PolicyInputs } from "../policy/pg-policy-source.js";
import type { HandoffStore } from "./handoff-store.js";

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
const MODEL = "claude-haiku-5-5"; // 500 cents per million output tokens: 2000 output tokens cost exactly 1 cent

describe.skipIf(!live)(
  "AGO-81 round 5 give-then-spend (live database)",
  { timeout: 60_000 },
  () => {
    let pool: pg.Pool;
    const ws = randomUUID();
    const user = randomUUID();
    const member = randomUUID();
    const id = () => randomUUID();
    const [A, B, C, D] = [id(), id(), id(), id()];
    const store = () => createPgHandoffStore(pool);

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await pool.query(
        "insert into public.workspaces (id, name) values ($1, 'AGO-81 give then spend')",
        [ws],
      );
      await pool.query(
        `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [user, `ago81-gts-${user}@example.test`],
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
    const cost = (runId: string, cents: unknown) =>
      event(runId, "budget.usage", { input_tokens: 1, output_tokens: 1, cost_cents: cents });
    const unknownOutcome = (runId: string, cents: number) =>
      event(runId, "budget.exceeded", { reason: "call_outcome_unknown_charged", used: cents });

    // --- the two enforcement points, built over the real store -------------------------------------------------
    const allowAll: BudgetGuard = {
      reserve: (): Promise<BudgetDecision> =>
        Promise.resolve({
          allowed: true,
          reservation: {
            workspaceId: ws,
            agentId: B,
            cents: 1,
            dayStart: "2026-11-20",
            monthStart: "2026-11-01",
          },
          estimateCents: 1,
        }),
      settle: () => Promise.resolve({ costCents: 1, overran: false, ledgerFailed: false }),
      release: () => Promise.resolve(),
      chargeReserved: () => Promise.resolve(),
    };
    /** Would the guard let a model call with a worst case of `cents` start on this run? */
    async function guardAllows(runId: string, agentId: string, cents: number): Promise<boolean> {
      const decision = await withHandoffBudget(allowAll, store()).reserve({
        workspaceId: ws,
        agentId,
        runId,
        model: MODEL,
        inputCharacters: 0,
        maxOutputTokens: cents * 2_000,
      });
      return decision.allowed;
    }
    const toolCall: PolicyToolCall = {
      callId: "c1",
      toolName: "read_note",
      input: {},
      tier: 0,
      capabilityKey: "vault.read",
      isRegistered: true,
    };
    const inputs: PolicyInputs = {
      agent: {
        mode: "strict",
        grants: [{ capabilityKey: "vault.read", tier: 0, mode: "automatic", isEnabled: true }],
      },
      policies: [],
    };
    const hookDecision = (
      runId: string,
      agentId: string,
      handoffStore: Pick<
        HandoffStore,
        "findByRun" | "spentCentsOnTask" | "allocatedCentsOnRun"
      > = store(),
    ) => {
      const context: PolicyContext = {
        workspaceId: ws,
        runId,
        agentId,
        step: 1,
        signal: new AbortController().signal,
      };
      return createHandoffPolicyHook({
        store: handoffStore,
        source: { load: () => Promise.resolve(inputs) },
      }).check(toolCall, context);
    };
    const hookAllows = async (runId: string, agentId: string): Promise<boolean> =>
      (await hookDecision(runId, agentId)).decision === "allow";
    /** The most the guard lets this run spend in ONE more call: binary-searched, so it reads the real limit off the guard. */
    async function guardHeadroom(runId: string, agentId: string): Promise<number> {
      let low = 0;
      let high = 200;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (await guardAllows(runId, agentId, mid)) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    // =============================================================================================================
    describe("AC2: depth 1, a grant of 100 totals 100 across own spend and children", () => {
      it("after giving 40 the task may spend 60 and not 61, by the guard", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        expect(await guardHeadroom(b.runId, B)).toBe(100);

        await handOver(b.runId, B, C, 40);

        expect(await guardHeadroom(b.runId, B)).toBe(60);
      });

      it("after giving 40 the hook allows a tool call until 60 is spent and denies it from then on", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);

        expect(await hookAllows(b.runId, B)).toBe(true);
        await cost(b.runId, 59);
        expect(await hookAllows(b.runId, B)).toBe(true);
        await cost(b.runId, 1);
        expect(await hookDecision(b.runId, B)).toEqual({
          decision: "deny",
          reasonCode: HANDOFF_BUDGET_EXHAUSTED,
        });
      });

      it("give then spend: the grant fills up to exactly 100 and no further, by gift, by spend and by the guard", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        // B spends what is left, one cent per call, asking the guard each time.
        let spentByB = 0;
        while (await guardAllows(b.runId, B, 1)) {
          await cost(b.runId, 1);
          spentByB += 1;
          expect(spentByB).toBeLessThanOrEqual(100); // a runaway loop is a failure, not a hang
        }
        expect(spentByB).toBe(60);
        expect(await hookAllows(b.runId, B)).toBe(false);
        // Nothing is left to give either: 60 spent + 40 given = 100.
        expect(await hop(b.runId, B, C, 1)).toEqual({ ok: false, reason: "widening_budget" });
      });

      it("spend then give: 30 spent leaves 70 to give; after giving 70 the task has 0 own headroom and is denied at once", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await cost(b.runId, 30);
        expect(await hop(b.runId, B, C, 71)).toEqual({ ok: false, reason: "widening_budget" });
        await handOver(b.runId, B, C, 70);

        expect(await guardHeadroom(b.runId, B)).toBe(0);
        expect((await hookDecision(b.runId, B)).reasonCode).toBe(HANDOFF_BUDGET_EXHAUSTED);
      });

      it("a task that gives the whole 100 away is denied at once with 0 spent, and the child holds the 100", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 100);

        expect(await hookAllows(b.runId, B)).toBe(false);
        expect(await guardAllows(b.runId, B, 1)).toBe(false);
        expect(await guardHeadroom(c.runId, C)).toBe(100); // the child can spend the gift
      });

      it("several small gifts reduce the limit by their sum", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        for (const cents of [10, 20, 5]) await handOver(b.runId, B, C, cents);

        expect(await guardHeadroom(b.runId, B)).toBe(65);
      });

      it("zero-budget children reduce nothing", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        // The worker tool refuses a budget of 0 (invalid_request); the database accepts it, so insert it directly.
        const chain = await store().loadChainForRun(ws, b.runId);
        if (chain === null) throw new Error("setup: run has no chain");
        for (let i = 0; i < 3; i += 1) {
          await store().insert({
            taskId: id(),
            workspaceId: ws,
            fromAgentId: B,
            senderRunId: b.runId,
            toAgentId: C,
            requesterMemberId: chain.requesterMemberId,
            path: [...chain.path, C],
            depth: chain.path.length,
            narrowed: { capabilities: [], budgetCents: 0, dataScope: [] },
            title: "zero",
            description: "",
            acceptedByRunId: null,
          });
        }
        expect(await store().allocatedCentsOnRun(ws, b.runId)).toBe(0);

        expect(await guardHeadroom(b.runId, B)).toBe(100);
        expect(await hookAllows(b.runId, B)).toBe(true);
      });

      it("a child spending part of its gift does not hand anything back to the sender's own limit", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 40);
        await cost(c.runId, 10); // the child spends its own task's money; the parent's limit stays 60

        expect(await guardHeadroom(b.runId, B)).toBe(60);
        expect(await guardHeadroom(c.runId, C)).toBe(30);
      });
    });

    // =============================================================================================================
    describe("AC2: depth 3, 40 + 30 + 30 totals 100", () => {
      it("B keeps 40, C keeps 30 and D gets 30: each task's headroom is its own share and the sum is the grant", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 60); // B keeps 40
        const d = await handOver(c.runId, C, D, 30); // C keeps 30

        const own = [
          await guardHeadroom(b.runId, B),
          await guardHeadroom(c.runId, C),
          await guardHeadroom(d.runId, D),
        ];
        expect(own).toEqual([40, 30, 30]);
        expect(own.reduce((sum, cents) => sum + cents, 0)).toBe(100);
      });

      it("the hook cuts each task off at its own share, and the others are unaffected", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 60);
        const d = await handOver(c.runId, C, D, 30);

        await cost(b.runId, 40);
        expect(await hookAllows(b.runId, B)).toBe(false);
        expect(await hookAllows(c.runId, C)).toBe(true);
        await cost(c.runId, 30);
        expect(await hookAllows(c.runId, C)).toBe(false);
        expect(await hookAllows(d.runId, D)).toBe(true);
        await cost(d.runId, 29);
        expect(await hookAllows(d.runId, D)).toBe(true);
        await cost(d.runId, 1);
        expect(await hookAllows(d.runId, D)).toBe(false);
      });

      it("all three spending their whole share totals 100 and every further call anywhere in the chain is refused", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 60);
        const d = await handOver(c.runId, C, D, 30);

        let total = 0;
        for (const [run, agent] of [
          [b.runId, B],
          [c.runId, C],
          [d.runId, D],
        ] as const) {
          while (await guardAllows(run, agent, 1)) {
            await cost(run, 1);
            total += 1;
            expect(total).toBeLessThanOrEqual(100);
          }
        }
        expect(total).toBe(100);
        for (const [run, agent] of [
          [b.runId, B],
          [c.runId, C],
          [d.runId, D],
        ] as const) {
          expect(await guardAllows(run, agent, 1)).toBe(false);
          expect(await hookAllows(run, agent)).toBe(false);
        }
      });

      it("the middle task gifts only count against the middle task, not against the root of the chain", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const c = await handOver(b.runId, B, C, 60);
        await handOver(c.runId, C, D, 30);

        expect(await store().allocatedCentsOnRun(ws, b.runId)).toBe(60);
        expect(await store().allocatedCentsOnRun(ws, c.runId)).toBe(30);
      });
    });

    // =============================================================================================================
    describe("AC2: what counts as spent when the limit is reduced", () => {
      it("a call whose outcome is unknown is charged at its held cents: 30 held plus 40 given leaves 30", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        await unknownOutcome(b.runId, 30);

        expect(await guardHeadroom(b.runId, B)).toBe(30);
      });

      it("an unknown-outcome charge that reaches the reduced limit denies the hook", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        await unknownOutcome(b.runId, 60);

        expect(await hookAllows(b.runId, B)).toBe(false);
      });

      it("usage and unknown-outcome charges add up together with the gift", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        await cost(b.runId, 20);
        await unknownOutcome(b.runId, 15);

        expect(await guardHeadroom(b.runId, B)).toBe(25);
      });

      it("a cost too large for the ledger (20 digits) counts as huge: nothing is left whatever was given", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 10);
        await cost(b.runId, "99999999999999999999");

        expect(await guardHeadroom(b.runId, B)).toBe(0);
        expect(await hookAllows(b.runId, B)).toBe(false);
      });

      it("a cost that is not a number counts as 0 and does not shrink the limit", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        await cost(b.runId, "free");
        await cost(b.runId, -50);

        expect(await guardHeadroom(b.runId, B)).toBe(60);
      });

      it("spent exactly equal to the grant with a gift of 0 is the boundary: denied, headroom 0", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await cost(b.runId, 100);

        expect(await hookAllows(b.runId, B)).toBe(false);
        expect(await guardHeadroom(b.runId, B)).toBe(0);
      });

      it("spent + given one cent below the grant still allows, at the boundary minus one", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        await handOver(b.runId, B, C, 40);
        await cost(b.runId, 59);

        expect(await hookAllows(b.runId, B)).toBe(true);
        expect(await guardHeadroom(b.runId, B)).toBe(1);
      });
    });

    // =============================================================================================================
    describe("AC2: guard and hook agree, and fail closed, on the real store", () => {
      it("for every spend and gift split of a 6 cent grant both answer the same and follow spent + given < grant", async () => {
        const GRANT = 6;
        const mismatches: string[] = [];
        for (let given = 0; given <= GRANT; given += 1) {
          for (let spent = 0; spent <= GRANT; spent += 1) {
            const root = await rootRun(A);
            const b = await handOver(root, A, B, GRANT);
            if (given > 0) await handOver(b.runId, B, C, given);
            if (spent > 0) await cost(b.runId, spent);
            const expected = spent + given < GRANT;
            const byGuard = await guardAllows(b.runId, B, 1);
            const byHook = await hookAllows(b.runId, B);
            if (byGuard !== expected || byHook !== expected) {
              mismatches.push(JSON.stringify({ given, spent, byGuard, byHook }));
            }
          }
        }
        expect(mismatches).toEqual([]);
      });

      it("when the gift lookup fails on the real store the guard refuses and the hook rejects (no allow)", async () => {
        const root = await rootRun(A);
        const b = await handOver(root, A, B, 100);
        const real = store();
        const broken = {
          findByRun: real.findByRun.bind(real),
          spentCentsOnTask: real.spentCentsOnTask.bind(real),
          allocatedCentsOnRun: () => Promise.reject(new Error("db down")),
        };
        const decision = await withHandoffBudget(allowAll, broken).reserve({
          workspaceId: ws,
          agentId: B,
          runId: b.runId,
          model: MODEL,
          inputCharacters: 0,
          maxOutputTokens: 2_000,
        });

        expect(decision).toMatchObject({ allowed: false, reason: "budget_check_failed" });
        await expect(hookDecision(b.runId, B, broken)).rejects.toThrow("db down");
      });

      it("a run on a task that is not a handoff is not limited by gifts (an ordinary run)", async () => {
        const root = await rootRun(A);
        await handOver(root, A, B, 100); // the root run gave 100 away; it is not a handoff task itself

        expect(await guardAllows(root, A, 100)).toBe(true);
        expect(await hookAllows(root, A)).toBe(true);
      });
    });
  },
);
