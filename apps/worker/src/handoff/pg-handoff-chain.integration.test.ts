// AGO-81 round 2, independent acceptance tests against the real local Postgres: "a handoff never grants more than the
// sender holds" on every hop, the narrowed budget, and the run-to-task clamp. Nothing here is mocked: the database
// functions, constraints and the real store run. It skips itself when the local Supabase stack is down. Run it inside
// the db lock, after a reset:
//   node scripts/db-lock.mjs acquire AGO-81 ... pnpm exec supabase db reset ... release AGO-81
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore, createRunEventEmitter } from "../events/index.js";
import {
  HANDOFF_BUDGET_EXHAUSTED,
  createHandoffPolicyHook,
} from "../policy/handoff-policy-hook.js";
import { createPgPolicySource } from "../policy/pg-policy-source.js";

import { acceptHandoff, createHandoff } from "./create-handoff.js";
import { createPgHandoffStore } from "./pg-handoff-store.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";
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
const SIGNAL = new AbortController().signal;
const FUNCTION_REFUSAL = "22023";

describe.skipIf(!live)("AGO-81 handoff chain rules (live database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  const ws = randomUUID();
  const users = [randomUUID(), randomUUID()];
  const member = randomUUID();
  const memberR = randomUUID();
  const id = () => randomUUID();
  // A..E: plain agents holding vault.read (tier 0) and tasks.manage (tier 1), both automatic.
  const [A, B, C, D, E] = [id(), id(), id(), id(), id()];
  const U = id(); // has spent 400 of its default 500 daily cents: 100 left
  const BIG = id(); // a stored daily budget of 5000, the largest the column allows
  const P = id(); // holds vault.read in approval mode
  const X = id(); // has spent its whole daily budget
  const store = () => createPgHandoffStore(pool);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-81 chain')", [ws]);
    for (const [index, memberId] of [member, memberR].entries()) {
      await pool.query(
        `insert into auth.users (id, instance_id, aud, role, email)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [users[index], `ago81-chain-${String(users[index])}@example.test`],
      );
      await pool.query(
        "insert into public.members (id, workspace_id, user_id, role) values ($1, $2, $3, 'member')",
        [memberId, ws, users[index]],
      );
    }
    for (const [agentId, name, daily] of [
      [A, "A", null],
      [B, "B", null],
      [C, "C", null],
      [D, "D", null],
      [E, "E", null],
      [U, "U", null],
      [BIG, "BIG", 5_000],
      [P, "P", null],
      [X, "X", null],
    ] as const) {
      await pool.query(
        "insert into public.agents (id, workspace_id, name, daily_budget_cents) values ($1, $2, $3, $4)",
        [agentId, ws, name, daily],
      );
    }
    await pool.query(
      `insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled) values
         ($1, 'vault.read', 'Read vault', 0, 'workspace', 'automatic', true),
         ($1, 'tasks.manage', 'Manage tasks', 1, 'workspace', 'automatic', true)
       on conflict (workspace_id, key) do update set tier = excluded.tier, enabled = true`,
      [ws],
    );
    for (const agentId of [A, B, C, D, E]) {
      await pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode) values
           ($1, $2, 'vault.read', 0, 'automatic'), ($1, $2, 'tasks.manage', 1, 'automatic')`,
        [ws, agentId],
      );
    }
    for (const agentId of [U, BIG, X]) {
      await pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
         values ($1, $2, 'vault.read', 0, 'automatic')`,
        [ws, agentId],
      );
    }
    await pool.query(
      `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
       values ($1, $2, 'vault.read', 0, 'approval')`,
      [ws, P],
    );
    for (const [agentId, used] of [
      [U, 400],
      [X, 500],
    ] as const) {
      await pool.query(
        `insert into public.budgets_usage (workspace_id, agent_id, period_start, period_end, cost_used_cents)
         values ($1, $2, (now() at time zone 'utc')::date, (now() at time zone 'utc')::date + 1, $3)`,
        [ws, agentId, used],
      );
    }
  });

  afterAll(async () => {
    await pool.query("delete from public.workspaces where id = $1", [ws]).catch(() => undefined);
    await pool
      .query("delete from auth.users where id = any($1::uuid[])", [users])
      .catch(() => undefined);
    await pool.end();
  });

  // --- fixtures: each test builds its own tasks and runs -------------------------------------------------------
  async function rootRun(agentId: string, createdBy: string = member): Promise<string> {
    const taskId = id();
    const runId = id();
    await pool.query(
      "insert into public.tasks (id, workspace_id, title, agent_id, created_by) values ($1, $2, 'root', $3, $4)",
      [taskId, ws, agentId, createdBy],
    );
    await pool.query(
      "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, $3, $4)",
      [runId, ws, taskId, agentId],
    );
    return runId;
  }
  /** A run of `agentId` on an existing task, as a queue would create it (nothing is accepted). */
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
  const hop = (runId: string, agentId: string, to: string, extra: object = {}) =>
    createHandoff(
      { store: store(), emitter: emitterFor(runId) },
      { workspaceId: ws, runId, agentId },
      { to_agent_id: to, title: "t", ...extra },
    );
  /** Hand off and have the receiver run it (accepted). Returns the task and the receiver's run. */
  async function handOver(runId: string, from: string, to: string, extra: object = {}) {
    const made = await hop(runId, from, to, extra);
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

  /** A record written straight through the database function, skipping every worker rule (the second line). */
  async function rawRecord(
    senderRun: string,
    to: string,
    narrowed: {
      capabilities?: readonly NarrowedGrant[];
      budgetCents?: number;
      dataScope?: readonly string[];
    },
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
      narrowed: {
        capabilities: [...(narrowed.capabilities ?? [])],
        budgetCents: narrowed.budgetCents ?? 1,
        dataScope: [...(narrowed.dataScope ?? [])],
      },
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
  const cap = (
    capabilityKey: string,
    tier: NarrowedGrant["tier"],
    mode: NarrowedGrant["mode"] = "automatic",
  ): NarrowedGrant => ({ capabilityKey, tier, mode });

  async function expectRefusedAndUnwritten(
    senderRun: string,
    to: string,
    narrowed: Parameters<typeof rawRecord>[2],
  ) {
    const record = await rawRecord(senderRun, to, narrowed);
    expect(await outcomeOf(store().insert(record))).toBe(FUNCTION_REFUSAL);
    expect(await taskCount(record.taskId)).toBe(0);
  }
  async function expectAccepted(
    senderRun: string,
    to: string,
    narrowed: Parameters<typeof rawRecord>[2],
  ) {
    const record = await rawRecord(senderRun, to, narrowed);
    expect(await outcomeOf(store().insert(record))).toBe("ok");
    expect(await taskCount(record.taskId)).toBe(1);
    return record;
  }

  // =============================================================================================================
  describe("AC2: widening on hop 2 and hop 3 (the parent handoff bounds every hop)", () => {
    it("B cannot hand C a capability A did not hand B, though B holds it itself (worker rule, real store)", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, { requested: { capabilities: ["vault.read"] } });

      expect(
        await hop(first.runId, B, C, { requested: { capabilities: ["tasks.manage"] } }),
      ).toEqual({
        ok: false,
        reason: "widening_capability",
      });
      const second = await hop(first.runId, B, C);
      if (!second.ok) throw new Error(`setup failed: ${second.reason}`);
      const stored = await store().findByTask(ws, second.taskId);
      expect(stored?.narrowed.capabilities.map((g) => g.capabilityKey)).toEqual(["vault.read"]);
    });

    it("the database refuses the same widening when the worker rule is skipped (hop 2)", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, { requested: { capabilities: ["vault.read"] } });
      await expectRefusedAndUnwritten(first.runId, C, { capabilities: [cap("tasks.manage", 1)] });
    });

    it("hop 3: a capability dropped on hop 1 stays dropped, in the worker and in the database", async () => {
      const root = await rootRun(A);
      const one = await handOver(root, A, B, { requested: { capabilities: ["vault.read"] } });
      const two = await handOver(one.runId, B, C);

      expect(await hop(two.runId, C, D, { requested: { capabilities: ["tasks.manage"] } })).toEqual(
        {
          ok: false,
          reason: "widening_capability",
        },
      );
      await expectRefusedAndUnwritten(two.runId, D, { capabilities: [cap("tasks.manage", 1)] });
      const three = await hop(two.runId, C, D);
      if (!three.ok) throw new Error(`setup failed: ${three.reason}`);
      expect(three.depth).toBe(3);
    });

    it("a fourth hop is refused (depth 4) and writes no task", async () => {
      const root = await rootRun(A);
      const one = await handOver(root, A, B);
      const two = await handOver(one.runId, B, C);
      const three = await handOver(two.runId, C, D);
      expect(await hop(three.runId, D, E)).toEqual({ ok: false, reason: "depth_exceeded" });
      await expectRefusedAndUnwritten(three.runId, E, {});
    });

    it("a tier-lowering request is refused: a handoff may raise the tier number, never lower it", async () => {
      const root = await rootRun(A); // A holds tasks.manage at tier 1
      await expectRefusedAndUnwritten(root, B, { capabilities: [cap("tasks.manage", 0)] });
      await expectAccepted(root, B, { capabilities: [cap("tasks.manage", 1)] });
      await expectAccepted(root, B, { capabilities: [cap("tasks.manage", 2)] });
      await expectAccepted(root, B, { capabilities: [cap("tasks.manage", 4)] });
    });

    it("approval mode never loosens: an approval sender cannot hand over automatic, an automatic sender may hand over approval", async () => {
      const approvalRoot = await rootRun(P);
      await expectRefusedAndUnwritten(approvalRoot, B, {
        capabilities: [cap("vault.read", 0, "automatic")],
      });
      await expectAccepted(approvalRoot, B, { capabilities: [cap("vault.read", 0, "approval")] });

      const automaticRoot = await rootRun(A);
      await expectAccepted(automaticRoot, B, { capabilities: [cap("vault.read", 0, "approval")] });
    });

    it("the parent's tier and mode bound the next hop (tier 2 approval passed on: lower tier or automatic is refused)", async () => {
      const root = await rootRun(A);
      // Budget 2: the two accepted children below take 1 cent each (budget given to children is held, round 4).
      const parent = await expectAccepted(root, B, {
        capabilities: [cap("tasks.manage", 2, "approval")],
        budgetCents: 2,
      });
      const bRun = await runOnTask(parent.taskId, B);

      await expectRefusedAndUnwritten(bRun, C, {
        capabilities: [cap("tasks.manage", 1, "approval")],
      });
      await expectRefusedAndUnwritten(bRun, C, {
        capabilities: [cap("tasks.manage", 2, "automatic")],
      });
      await expectAccepted(bRun, C, { capabilities: [cap("tasks.manage", 2, "approval")] });
      await expectAccepted(bRun, C, { capabilities: [cap("tasks.manage", 3, "approval")] });
    });

    it("through the worker, the next hop inherits the parent's stricter tier and approval mode", async () => {
      const root = await rootRun(A);
      const parent = await expectAccepted(root, B, {
        capabilities: [cap("tasks.manage", 2, "approval")],
      });
      const bRun = await runOnTask(parent.taskId, B);

      const next = await hop(bRun, B, C, { requested: { capabilities: ["tasks.manage"] } });
      if (!next.ok) throw new Error(`setup failed: ${next.reason}`);
      const stored = await store().findByTask(ws, next.taskId);
      expect(stored?.narrowed.capabilities).toHaveLength(1);
      const [grant] = stored?.narrowed.capabilities ?? [];
      expect(grant?.tier).toBeGreaterThanOrEqual(2);
      expect(grant?.mode).toBe("approval");
    });

    it("a capability the sender does not hold at all is refused", async () => {
      const root = await rootRun(U); // U holds vault.read only
      await expectRefusedAndUnwritten(root, B, { capabilities: [cap("tasks.manage", 1)] });
    });

    it("a capability the sender holds but the catalog has disabled is refused", async () => {
      const probe = id();
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'probe')",
        [probe, ws],
      );
      await pool.query(
        `insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled)
         values ($1, 'probe.off', 'Disabled', 0, 'workspace', 'automatic', false)
         on conflict (workspace_id, key) do update set enabled = false`,
        [ws],
      );
      await pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
         values ($1, $2, 'probe.off', 0, 'automatic')`,
        [ws, probe],
      );
      const root = await rootRun(probe);
      await expectRefusedAndUnwritten(root, B, { capabilities: [cap("probe.off", 0)] });
    });
  });

  // =============================================================================================================
  describe("AC2: the budget is bounded in the database and along the chain", () => {
    it("accepts a budget exactly equal to the sender's remaining budget and refuses one cent more", async () => {
      const root = await rootRun(U); // 500 - 400 = 100 left
      await expectRefusedAndUnwritten(root, B, { budgetCents: 101 });
      await expectAccepted(root, B, { budgetCents: 100 });
    });

    it("caps the handoff at the largest daily budget (5000): 5000 passes, 5001 does not", async () => {
      const root = await rootRun(BIG);
      await expectRefusedAndUnwritten(root, B, { budgetCents: 5001 });
      await expectAccepted(root, B, { budgetCents: 5000 });
    });

    it("refuses a negative budget", async () => {
      const root = await rootRun(A);
      await expectRefusedAndUnwritten(root, B, { budgetCents: -1 });
    });

    it("refuses a fractional budget", async () => {
      const root = await rootRun(A);
      await expectRefusedAndUnwritten(root, B, { budgetCents: 1.5 });
    });

    it("refuses an oversized budget, written in plain digits or in exponent form", async () => {
      const root = await rootRun(A);
      await expectRefusedAndUnwritten(root, B, { budgetCents: 10 ** 12 }); // 13 digits
      await expectRefusedAndUnwritten(root, B, { budgetCents: 1e21 }); // JSON.stringify gives 1e+21
      await expectRefusedAndUnwritten(root, B, { budgetCents: Number.MAX_SAFE_INTEGER });
    });

    it("hop 2: a budget above the parent handoff's budget is refused even though the sender has more left", async () => {
      const root = await rootRun(A);
      const parent = await expectAccepted(root, B, { budgetCents: 100 });
      const bRun = await runOnTask(parent.taskId, B);
      await expectRefusedAndUnwritten(bRun, C, { budgetCents: 101 });
      await expectAccepted(bRun, C, { budgetCents: 100 });
    });

    it("hop 3: the budget keeps shrinking; the third hop cannot regain what hop 2 gave up", async () => {
      const root = await rootRun(A);
      const one = await handOver(root, A, B, { requested: { budget_cents: 100 } });
      const two = await handOver(one.runId, B, C, { requested: { budget_cents: 40 } });
      expect(await hop(two.runId, C, D, { requested: { budget_cents: 41 } })).toEqual({
        ok: false,
        reason: "widening_budget",
      });
      await expectRefusedAndUnwritten(two.runId, D, { budgetCents: 41 });
      const three = await hop(two.runId, C, D, { requested: { budget_cents: 40 } });
      if (!three.ok) throw new Error(`setup failed: ${three.reason}`);
      expect((await store().findByTask(ws, three.taskId))?.narrowed.budgetCents).toBe(40);
    });

    it("a sender with no budget left cannot hand off (worker: no_budget)", async () => {
      const root = await rootRun(X);
      expect(await hop(root, X, B)).toEqual({ ok: false, reason: "no_budget" });
    });

    it("the worker refuses one cent over the sender's remaining budget and allows the exact remainder", async () => {
      const root = await rootRun(U);
      expect(await hop(root, U, B, { requested: { budget_cents: 101 } })).toEqual({
        ok: false,
        reason: "widening_budget",
      });
      const exact = await hop(root, U, B, { requested: { budget_cents: 100 } });
      expect(exact.ok).toBe(true);
    });
  });

  // =============================================================================================================
  describe("AC2: data scope, requester and table backstops", () => {
    it("refuses a non-empty data scope: no agent has a stored scope to pass on", async () => {
      const root = await rootRun(A);
      await expectRefusedAndUnwritten(root, B, { dataScope: ["projects/"] });
      await expectAccepted(root, B, { dataScope: [] });
    });

    it("refuses a requester who has been removed from the workspace, through the worker too", async () => {
      const root = await rootRun(A, memberR);
      await pool.query("update public.members set removed_at = now() where id = $1", [memberR]);
      try {
        await expect(hop(root, A, B)).rejects.toMatchObject({ code: FUNCTION_REFUSAL });
        await expectRefusedAndUnwritten(root, B, {});
        const rows = await pool.query<{ n: number }>(
          "select count(*)::int as n from public.tasks where workspace_id = $1 and requester_member_id = $2",
          [ws, memberR],
        );
        expect(rows.rows[0]?.n).toBe(0);
      } finally {
        await pool.query("update public.members set removed_at = null where id = $1", [memberR]);
      }
    });

    it("refuses a NULL entry in handoff_path at the table, and accepts the same row with real ids", async () => {
      const insertHandoffRow = (path: (string | null)[]) =>
        pool.query(
          `insert into public.tasks (id, workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id,
                                     handoff_depth, handoff_path, handoff_grants)
           values ($1, $2, 'row', $3, $4, $5, 2, $6::uuid[], '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb)`,
          [id(), ws, C, B, member, path],
        );
      // Control: the shape is valid with real ids, so the failure below is caused by the NULL alone.
      await expect(insertHandoffRow([A, B, C])).resolves.toBeDefined();
      await expect(insertHandoffRow([null, B, C])).rejects.toMatchObject({ code: "23514" });
      await expect(insertHandoffRow([A, null, C])).rejects.toMatchObject({ code: "23514" });
    });
  });

  // =============================================================================================================
  describe("AC2: a run on a handoff task is clamped through runs.task_id, whether or not it was accepted", () => {
    const call = (capabilityKey: string, tier: PolicyToolCall["tier"]): PolicyToolCall => ({
      callId: "call-1",
      toolName: "tool",
      input: {},
      capabilityKey,
      tier,
      isRegistered: true,
    });
    const context = (runId: string, agentId: string): PolicyContext => ({
      workspaceId: ws,
      runId,
      agentId,
      step: 1,
      signal: SIGNAL,
    });
    const hookOver = () =>
      createHandoffPolicyHook({ source: createPgPolicySource(pool), store: store() });

    it("an unlinked run (nobody called accept) gets the intersection, not B's own grants", async () => {
      const root = await rootRun(A);
      const made = await hop(root, A, B, { requested: { capabilities: ["vault.read"] } });
      if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
      const unlinked = await runOnTask(made.taskId, B);

      expect((await store().findByTask(ws, made.taskId))?.acceptedByRunId).toBeNull();
      expect((await store().findByRun(ws, unlinked))?.taskId).toBe(made.taskId);
      expect((await hookOver().check(call("vault.read", 0), context(unlinked, B))).decision).toBe(
        "allow",
      );
      expect(await hookOver().check(call("tasks.manage", 1), context(unlinked, B))).toMatchObject({
        decision: "deny",
        reasonCode: "not_granted",
      });
    });

    it("a second run on the same handoff task is clamped as well", async () => {
      const root = await rootRun(A);
      const first = await handOver(root, A, B, { requested: { capabilities: ["vault.read"] } });
      const second = await runOnTask(first.taskId, B);
      expect(await hookOver().check(call("tasks.manage", 1), context(second, B))).toMatchObject({
        decision: "deny",
        reasonCode: "not_granted",
      });
    });

    it("a run on an ordinary task is not clamped, and a run id from another workspace resolves to nothing", async () => {
      const root = await rootRun(B);
      expect(await store().findByRun(ws, root)).toBeNull();
      expect((await hookOver().check(call("tasks.manage", 1), context(root, B))).decision).toBe(
        "allow",
      );
      expect(await store().findByRun(id(), root)).toBeNull();
    });

    it("a hop-2 receiver that never accepted is clamped to what the parent passed, not to what its own task passed", async () => {
      const root = await rootRun(A);
      const one = await handOver(root, A, B, { requested: { capabilities: ["vault.read"] } });
      const two = await hop(one.runId, B, C);
      if (!two.ok) throw new Error(`setup failed: ${two.reason}`);
      const unlinked = await runOnTask(two.taskId, C);
      expect(await hookOver().check(call("tasks.manage", 1), context(unlinked, C))).toMatchObject({
        decision: "deny",
        reasonCode: "not_granted",
      });
    });
  });

  // =============================================================================================================
  describe("AC2: the narrowed budget counts real budget.usage events and denies once it is spent", () => {
    const toolCall: PolicyToolCall = {
      callId: "call-1",
      toolName: "tool",
      input: {},
      capabilityKey: "vault.read",
      tier: 0,
      isRegistered: true,
    };
    const contextFor = (runId: string, agentId: string): PolicyContext => ({
      workspaceId: ws,
      runId,
      agentId,
      step: 1,
      signal: SIGNAL,
    });
    const usage = (runId: string, payload: Record<string, unknown>, type = "budget.usage") =>
      pool.query(
        "insert into public.run_events (workspace_id, run_id, type, payload) values ($1, $2, $3, $4::jsonb)",
        [ws, runId, type, JSON.stringify(payload)],
      );
    const cost = (runId: string, cents: unknown) =>
      usage(runId, { input_tokens: 1, output_tokens: 1, cost_cents: cents });
    const hook = () =>
      createHandoffPolicyHook({ source: createPgPolicySource(pool), store: store() });

    async function handoffWithBudget(budget: number) {
      const root = await rootRun(A);
      const made = await hop(root, A, B, {
        requested: { budget_cents: budget, capabilities: ["vault.read"] },
      });
      if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
      return { taskId: made.taskId, runId: await runOnTask(made.taskId, B) };
    }

    it("sums budget.usage across every run on the task, and nothing from other tasks or other event types", async () => {
      const mine = await handoffWithBudget(400);
      const secondRun = await runOnTask(mine.taskId, B);
      const other = await handoffWithBudget(400);
      await cost(mine.runId, 30);
      await cost(secondRun, 20);
      await cost(other.runId, 999);
      await usage(mine.runId, { cost_cents: 500 }, "tool.completed");
      expect(await store().spentCentsOnTask(ws, mine.taskId)).toBe(50);
      expect(await store().spentCentsOnTask(ws, other.taskId)).toBe(999);
    });

    it("is zero for a task nobody has spent on", async () => {
      const fresh = await handoffWithBudget(10);
      expect(await store().spentCentsOnTask(ws, fresh.taskId)).toBe(0);
    });

    it("ignores a cost payload that is not a whole number instead of failing or guessing", async () => {
      const task = await handoffWithBudget(400);
      await cost(task.runId, 7);
      for (const bad of [
        "abc",
        "",
        "1.5",
        "-5",
        "1e3",
        " 9 ",
        null,
        true,
        [4],
        { cents: 4 },
        2.5,
        -3,
      ]) {
        await cost(task.runId, bad);
      }
      await usage(task.runId, { input_tokens: 1, output_tokens: 1 }); // no cost_cents at all
      expect(await store().spentCentsOnTask(ws, task.taskId)).toBe(7);
    });

    it("a cost too large for the ledger never raises 22003 (the cast sits inside a CASE) and counts as LARGE, so the budget is spent (round 4)", async () => {
      const task = await handoffWithBudget(400);
      await cost(task.runId, 7);
      await usage(task.runId, { cost_cents: "99999999999999999999999" });
      await usage(task.runId, { cost_cents: "1234567890123" }); // 13 digits: outside ^[0-9]{1,12}$
      await expect(store().spentCentsOnTask(ws, task.taskId)).resolves.toBeGreaterThanOrEqual(
        999_999_999_999,
      );
      expect(await hook().check(toolCall, contextFor(task.runId, B))).toEqual({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
    });

    it("an unknown-outcome call (budget.exceeded, call_outcome_unknown_charged) counts toward the handoff budget (round 4)", async () => {
      const task = await handoffWithBudget(50);
      await usage(
        task.runId,
        { scope: "ledger", reason: "call_outcome_unknown_charged", limit: 20, used: 20 },
        "budget.exceeded",
      );
      await usage(
        task.runId,
        { scope: "ledger", reason: "call_cost_overran_reservation", limit: 20, used: 99 },
        "budget.exceeded",
      );
      await expect(store().spentCentsOnTask(ws, task.taskId)).resolves.toBe(20);
      expect((await hook().check(toolCall, contextFor(task.runId, B))).decision).toBe("allow");
      await usage(
        task.runId,
        { scope: "ledger", reason: "call_outcome_unknown_charged", limit: 30, used: 30 },
        "budget.exceeded",
      );
      expect(await hook().check(toolCall, contextFor(task.runId, B))).toEqual({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
    });

    it("allows a call while spending is below the cap and denies it when spending equals the cap", async () => {
      const task = await handoffWithBudget(50);
      const second = await runOnTask(task.taskId, B);
      await cost(task.runId, 49);
      expect((await hook().check(toolCall, contextFor(task.runId, B))).decision).toBe("allow");
      await cost(second, 1); // another run on the same task takes the total to exactly 50
      expect(await hook().check(toolCall, contextFor(task.runId, B))).toEqual({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
      expect(await hook().check(toolCall, contextFor(second, B))).toEqual({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
    });

    it("denies at once when the handoff carries a zero budget", async () => {
      const root = await rootRun(A);
      const record = await expectAccepted(root, B, {
        capabilities: [cap("vault.read", 0)],
        budgetCents: 0,
      });
      const run = await runOnTask(record.taskId, B);
      expect(await hook().check(toolCall, contextFor(run, B))).toEqual({
        decision: "deny",
        reasonCode: HANDOFF_BUDGET_EXHAUSTED,
      });
    });

    it("does not touch a run on an ordinary task even when that run has spent a lot", async () => {
      const root = await rootRun(B);
      await cost(root, 100_000);
      expect((await hook().check(toolCall, contextFor(root, B))).decision).toBe("allow");
    });
  });
});
