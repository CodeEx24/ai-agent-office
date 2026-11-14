// AGO-47 functional tests, live database: the grant path through the real agent loop, the real Postgres
// approval store and the real run_events table (scripted model, no network). It skips itself when the shared
// local Supabase stack is down. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-47 ... release AGO-47
// A human approving is simulated the way the RLS-limited decide route will write it: status only.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  T0,
  TTL_MS,
  allowAll,
  attempt,
  denyAll,
  failedCodes,
  scriptedModel,
  spyTool,
} from "../agent/agent-loop.approvals.invariants.test-helpers.js";
import { createMemoryCheckpointStore } from "../agent/checkpoint-store.test-helpers.js";
import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore } from "../events/pg-run-event-store.js";
import { approvalIdFor } from "./approval-id.js";
import { createPgApprovalStore } from "./approval-store.js";

import type { RunCheckpointState } from "@ago/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();

const WS = randomUUID();
const OTHER_WS = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();

describe.skipIf(!live)("AGO-47 grant path (live database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  const approvals = () => createPgApprovalStore(pool);
  const runEvents = () => createPgRunEventStore(pool);

  const newRun = async (workspaceId = WS, agentId = AGENT): Promise<string> => {
    const id = randomUUID();
    await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
      id,
      workspaceId,
      agentId,
    ]);
    return id;
  };
  const rowOf = async (id: string) =>
    (
      await pool.query<{ status: string; consumed_at: Date | null; payload_hash: string }>(
        "select status, consumed_at, payload_hash from public.approvals where id = $1",
        [id],
      )
    ).rows[0];
  const humanApproves = (id: string) =>
    pool.query("update public.approvals set status = 'approved' where id = $1", [id]);
  const idOf = (runId: string, callId = "toolu_0") => approvalIdFor({ runId, step: 1, callId });

  /** First attempt of a run with one tier 3 call, on the real stores. */
  async function pauseLive(options: { calls?: string[]; startMs?: number } = {}) {
    const runId = await newRun();
    const risky = spyTool("risky", 3);
    const checkpoints = createMemoryCheckpointStore();
    const clock = { now: options.startMs ?? T0 };
    const first = attempt({
      provider: scriptedModel(options.calls ?? ["risky"]).provider,
      tools: [risky],
      checkpoints,
      approvals: approvals(),
      policy: allowAll,
      clock,
      runId,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });
    const outcome = await first.loop.execute(first.ctx);
    return { runId, risky, checkpoints, clock, outcome };
  }
  type Live = Awaited<ReturnType<typeof pauseLive>>;

  const resumeLive = (
    world: Live,
    over: { checkpoints?: Live["checkpoints"]; policy?: typeof allowAll } = {},
  ) => {
    const b = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [world.risky],
      checkpoints: over.checkpoints ?? world.checkpoints,
      approvals: approvals(),
      policy: over.policy ?? allowAll,
      clock: world.clock,
      runId: world.runId,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });
    return { ...b, run: () => b.loop.execute(b.ctx) };
  };

  const ref = (world: Live) => ({ workspaceId: WS, runId: world.runId });
  const saved = (world: Live): RunCheckpointState => {
    const state = world.checkpoints.peek(ref(world));
    if (state === null) throw new Error("no checkpoint");
    return structuredClone(state);
  };
  /** A second worker's view of the same paused run: its own checkpoint store holding the same state. */
  const clonedCheckpoints = (world: Live) => {
    const copy = createMemoryCheckpointStore();
    copy.setRaw(ref(world), saved(world));
    return copy;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
    for (const [workspace, agent] of [
      [WS, AGENT],
      [OTHER_WS, OTHER_AGENT],
    ] as const) {
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-47 grant')", [
        workspace,
      ]);
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'a')", [
        agent,
        workspace,
      ]);
    }
  });

  afterAll(async () => {
    // run_events is append-only: clean up the way scripts/run-events-teardown.mjs does, in one transaction.
    const ids = `'${WS}', '${OTHER_WS}'`;
    await pool.query(`
      begin;
      delete from public.approvals where workspace_id in (${ids});
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id in (${ids});
      delete from public.agents where workspace_id in (${ids});
      delete from public.workspaces where id in (${ids});
      commit;`);
    await pool.end();
  });

  describe("AC1: a changed payload is rejected", () => {
    it("refuses a call edited after approval, runs nothing and leaves the row unused", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));
      const state = saved(world) as unknown as { step: { calls: { input: unknown }[] } };
      const call = state.step.calls[0];
      if (call === undefined) throw new Error("no saved call");
      call.input = { i: 0, extra: "changed after approval" };
      world.checkpoints.setRaw(ref(world), state);

      const b = resumeLive(world);
      await b.run();

      expect(failedCodes(b.rows)).toEqual(["approval_payload_mismatch"]);
      expect(world.risky.run).not.toHaveBeenCalled();
      expect((await rowOf(idOf(world.runId)))?.consumed_at).toBeNull();
    });
  });

  describe("AC1-AC2: the approved call runs once", () => {
    it("runs the approved call exactly once and stamps consumed_at, keeping the human's status", async () => {
      const world = await pauseLive();
      expect(world.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
      await humanApproves(idOf(world.runId));

      const b = resumeLive(world);
      const outcome = await b.run();

      expect(outcome.end).toBe("completed");
      expect(world.risky.run).toHaveBeenCalledTimes(1);
      const row = await rowOf(idOf(world.runId));
      expect(row?.consumed_at).not.toBeNull();
      expect(row?.status).toBe("approved");
    });

    it("refuses the same approval a second time and does not run the tool again", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));
      const awaiting = saved(world);
      await resumeLive(world).run();
      expect(world.risky.run).toHaveBeenCalledTimes(1);

      // The call is awaiting approval again: a crash after the grant, before the result was saved.
      world.checkpoints.setRaw(ref(world), awaiting);
      const again = resumeLive(world);
      await again.run();

      expect(failedCodes(again.rows)).toEqual(["approval_already_used"]);
      expect(world.risky.run).toHaveBeenCalledTimes(1);
    });

    it("lets exactly one of two workers resuming the same approved run execute the tool", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));
      const workerA = resumeLive(world, { checkpoints: clonedCheckpoints(world) });
      const workerB = resumeLive(world, { checkpoints: clonedCheckpoints(world) });

      await Promise.all([workerA.run(), workerB.run()]);

      expect(world.risky.run).toHaveBeenCalledTimes(1);
      const codes = [...failedCodes(workerA.rows), ...failedCodes(workerB.rows)];
      expect(codes).toEqual(["approval_already_used"]);
      expect((await rowOf(idOf(world.runId)))?.consumed_at).not.toBeNull();
    });
  });

  describe("AC3: approvals expire at their limit", () => {
    it("refuses an approved row at exactly its limit and leaves it unused", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));
      world.clock.now = T0 + TTL_MS;

      const b = resumeLive(world);
      await b.run();

      expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
      expect(world.risky.run).not.toHaveBeenCalled();
      expect((await rowOf(idOf(world.runId)))?.consumed_at).toBeNull();
    });

    it("runs an approved row one millisecond before its limit", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));
      world.clock.now = T0 + TTL_MS - 1;

      await resumeLive(world).run();

      expect(world.risky.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("policy re-check before the consume", () => {
    it("does not consume an approved call that the policy now denies", async () => {
      const world = await pauseLive();
      await humanApproves(idOf(world.runId));

      const b = resumeLive(world, { policy: denyAll });
      await b.run();

      expect(world.risky.run).not.toHaveBeenCalled();
      expect((await rowOf(idOf(world.runId)))?.consumed_at).toBeNull();
    });
  });

  describe("call index bound into the approval", () => {
    it("gives two calls with the same id their own approval rows, and call 0's grant does not run call 1", async () => {
      const runId = await newRun();
      const risky = spyTool("risky", 3);
      const checkpoints = createMemoryCheckpointStore();
      const clock = { now: T0 };
      const twin = {
        complete: () =>
          Promise.resolve({
            text: "",
            toolCalls: [
              { id: "dup", name: "risky", input: { n: 1 } },
              { id: "dup", name: "risky", input: { n: 1 } },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
      };
      const first = attempt({
        provider: twin,
        tools: [risky],
        checkpoints,
        approvals: approvals(),
        policy: allowAll,
        clock,
        runId,
        workspaceId: WS,
        agentId: AGENT,
        events: runEvents(),
      });
      await first.loop.execute(first.ctx);
      await humanApproves(approvalIdFor({ runId, step: 1, callId: "dup" }));

      const second = attempt({
        provider: scriptedModel([]).provider,
        tools: [risky],
        checkpoints,
        approvals: approvals(),
        policy: allowAll,
        clock,
        runId,
        workspaceId: WS,
        agentId: AGENT,
        events: runEvents(),
      });
      const outcome = await second.loop.execute(second.ctx);

      expect(risky.run).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
      const rows = await pool.query<{ id: string; status: string; consumed_at: Date | null }>(
        "select id, status, consumed_at from public.approvals where run_id = $1 order by created_at, id",
        [runId],
      );
      expect(rows.rowCount).toBe(2);
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(
        byId.get(approvalIdFor({ runId, step: 1, callId: "dup" }))?.consumed_at,
      ).not.toBeNull();
      expect(byId.get(approvalIdFor({ runId, step: 1, callId: "call_1_1" }))).toMatchObject({
        status: "pending",
        consumed_at: null,
      });
    });
  });

  describe("workspace scoping", () => {
    it("never lets an approval in another workspace grant this run's call", async () => {
      const world = await pauseLive();
      const id = idOf(world.runId);
      await humanApproves(id);
      // The same approval id looked up from another workspace finds nothing to consume.
      const otherRun = await newRun(OTHER_WS, OTHER_AGENT);
      const stolen = await approvals().consume(
        { workspaceId: OTHER_WS, runId: otherRun, approvalId: id },
        (await rowOf(id))?.payload_hash ?? "",
        new Date(T0),
      );

      expect(stolen).toBeNull();
      expect((await rowOf(id))?.consumed_at).toBeNull();
    });
  });
});
