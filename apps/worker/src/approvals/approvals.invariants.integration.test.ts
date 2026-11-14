// AGO-21 functional tests, live database: the approval invariants through the real Postgres approval store,
// the real run_events table and the real agent loop (scripted model, no network). It skips itself when the
// shared local Supabase stack is down. Run it inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-21 ... release AGO-21
// Every expiry sweep here passes its own `now`, so it only moves rows these tests made.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { createLogger } from "../logger.js";
import { approvalIdFor } from "./approval-id.js";
import { ApprovalConflictError, createPgApprovalStore } from "./approval-store.js";
import { expireDueApprovals } from "./expire-approvals.js";

import type { RunRef } from "../queue/run-store.js";

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
const NOW = T0 + TTL_MS; // the moment an approval raised at T0 is exactly due
// The sweep tests raise their approvals ten days earlier, so a sweep at their due time cannot move the
// pending rows other tests leave behind (those are raised at T0).
const EARLY = T0 - 10 * 24 * 60 * 60 * 1_000;
const EARLY_NOW = EARLY + TTL_MS;
const LATE = T0 + 100 * TTL_MS; // long after everything is due

describe.skipIf(!live)("AGO-21 approval invariants (live database)", { timeout: 60_000 }, () => {
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
  const dbEvents = async (runId: string) =>
    (
      await pool.query<{ id: string; type: string; payload: Record<string, unknown> }>(
        "select id, type, payload from public.run_events where run_id = $1 order by seq",
        [runId],
      )
    ).rows;
  const decidedInDb = async (runId: string) =>
    (await dbEvents(runId)).filter((row) => row.type === "approval.decided");
  const statusOf = async (id: string): Promise<string> =>
    (
      await pool.query<{ status: string }>("select status from public.approvals where id = $1", [
        id,
      ])
    ).rows[0]?.status ?? "missing";
  const idOf = (runId: string, callIndex = 0) =>
    approvalIdFor({ runId, step: 1, callId: `toolu_${String(callIndex)}` });

  /** First attempt of a run with one tier 3 call, on the real stores. */
  async function pauseLive(startMs = T0) {
    const runId = await newRun();
    const risky = spyTool("risky", 3);
    const checkpoints = createMemoryCheckpointStore();
    const clock = { now: startMs };
    const first = attempt({
      provider: scriptedModel(["risky"]).provider,
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
    return { runId, risky, checkpoints, clock, first, outcome };
  }
  type Live = Awaited<ReturnType<typeof pauseLive>>;

  const resumeLive = (world: Live) =>
    attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [world.risky],
      checkpoints: world.checkpoints,
      approvals: approvals(),
      policy: allowAll,
      clock: world.clock,
      runId: world.runId,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });

  const sweepLive = (now: number) => {
    const wake = vi.fn((_ref: RunRef) => Promise.resolve("resumed" as const));
    const run = () =>
      expireDueApprovals({
        approvals: approvals(),
        events: runEvents(),
        control: { resumeAfterApprovalExpiry: wake },
        logger: createLogger({ level: "silent" }),
        now: () => now,
      });
    return { wake, run };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
    for (const [workspace, agent] of [
      [WS, AGENT],
      [OTHER_WS, OTHER_AGENT],
    ] as const) {
      await pool.query(
        "insert into public.workspaces (id, name) values ($1, 'AGO-21 invariants')",
        [workspace],
      );
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

  it("raises one pending row bound to the call, and pauses, on the first attempt (AC1)", async () => {
    const world = await pauseLive();

    expect(world.outcome).toMatchObject({ end: "paused", pauseReason: "approval_required" });
    expect(world.risky.run).not.toHaveBeenCalled();
    const rows = await pool.query<{ status: string; action: string; workspace_id: string }>(
      "select status, action, workspace_id from public.approvals where run_id = $1",
      [world.runId],
    );
    expect(rows.rows).toEqual([{ status: "pending", action: "risky", workspace_id: WS }]);
    const requested = (await dbEvents(world.runId)).filter((r) => r.type === "approval.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload.approval_id).toBe(idOf(world.runId));
  });

  it("creates no approval row for tier 0, tier 1, denied or unknown-tool calls (AC3)", async () => {
    const runId = await newRun();
    const t0 = spyTool("clock", 0);
    const t1 = spyTool("read", 1);
    const run = attempt({
      provider: scriptedModel(["clock", "read"]).provider,
      tools: [t0, t1],
      checkpoints: createMemoryCheckpointStore(),
      approvals: approvals(),
      policy: allowAll,
      clock: { now: T0 },
      runId,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });
    expect(await run.loop.execute(run.ctx)).toMatchObject({ end: "completed" });

    const deniedRunId = await newRun();
    const denied = attempt({
      provider: scriptedModel(["read", "ghost"]).provider,
      tools: [spyTool("read", 1)],
      checkpoints: createMemoryCheckpointStore(),
      approvals: approvals(),
      policy: denyAll,
      clock: { now: T0 },
      runId: deniedRunId,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });
    await denied.loop.execute(denied.ctx);

    expect(t0.run).toHaveBeenCalledTimes(1);
    expect(t1.run).toHaveBeenCalledTimes(1);
    const count = await pool.query(
      "select 1 from public.approvals where run_id = any($1::uuid[])",
      [[runId, deniedRunId]],
    );
    expect(count.rowCount).toBe(0);
  });

  it("raising the same call twice leaves one row, and a conflicting row is refused (invariant 4)", async () => {
    const world = await pauseLive();
    await world.checkpoints.clear({ workspaceId: WS, runId: world.runId });
    const again = resumeLive(world);

    expect(await again.loop.execute(again.ctx)).toMatchObject({ end: "paused" });

    const rows = await pool.query("select 1 from public.approvals where run_id = $1", [
      world.runId,
    ]);
    expect(rows.rowCount).toBe(1);

    // A row with the call's id that is bound to a different payload is never adopted.
    const poisonedRun = await newRun();
    await pool.query(
      `insert into public.approvals (id, workspace_id, run_id, agent_id, action, payload_hash, status, expires_at)
       values ($1, $2, $3, $4, 'risky', $5, 'approved', $6)`,
      [idOf(poisonedRun), WS, poisonedRun, AGENT, "0".repeat(64), new Date(T0 + TTL_MS * 100)],
    );
    const risky = spyTool("risky", 3);
    const poisoned = attempt({
      provider: scriptedModel(["risky"]).provider,
      tools: [risky],
      checkpoints: createMemoryCheckpointStore(),
      approvals: approvals(),
      policy: allowAll,
      clock: { now: T0 },
      runId: poisonedRun,
      workspaceId: WS,
      agentId: AGENT,
      events: runEvents(),
    });
    await expect(poisoned.loop.execute(poisoned.ctx)).rejects.toBeInstanceOf(ApprovalConflictError);
    expect(risky.run).not.toHaveBeenCalled();
    expect(await statusOf(idOf(poisonedRun))).toBe("approved");
  });

  it("denies at resume when the sweeper never ran: rejected, one decided event, tool not run (invariant 2)", async () => {
    const world = await pauseLive();
    world.clock.now = NOW;
    const b = resumeLive(world);

    const outcome = await b.loop.execute(b.ctx);

    expect(outcome.end).toBe("completed");
    expect(world.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(b.rows)).toEqual(["approval_expired"]);
    expect(await statusOf(idOf(world.runId))).toBe("rejected");
    const decided = await decidedInDb(world.runId);
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({ outcome: "expired", decided_by: "timeout" });

    // A late sweeper then has nothing to do for this run: no wake-up, still one event.
    const late = sweepLive(NOW + 1);
    await late.run();
    expect(late.wake.mock.calls.some(([ref]) => ref.runId === world.runId)).toBe(false);
    expect(await decidedInDb(world.runId)).toHaveLength(1);
  });

  it("keeps a still-pending, not-yet-due approval waiting: no event, no new row, tool not run", async () => {
    const world = await pauseLive();
    world.clock.now = NOW - 1;
    const b = resumeLive(world);

    expect(await b.loop.execute(b.ctx)).toMatchObject({ end: "paused" });

    expect(world.risky.run).not.toHaveBeenCalled();
    expect(await statusOf(idOf(world.runId))).toBe("pending");
    expect(await decidedInDb(world.runId)).toHaveLength(0);
    expect(
      (await dbEvents(world.runId)).filter((r) => r.type === "approval.requested"),
    ).toHaveLength(1);
  });

  it("does not run an approved or denied row and leaves its status as the human set it", async () => {
    const approved = await pauseLive();
    const denied = await pauseLive();
    // Stand-in for the human decide path (AGO-58): the owner connection writes the status.
    await pool.query("update public.approvals set status = 'approved' where id = $1", [
      idOf(approved.runId),
    ]);
    await pool.query("update public.approvals set status = 'denied' where id = $1", [
      idOf(denied.runId),
    ]);
    approved.clock.now = LATE;
    denied.clock.now = LATE;
    const a = resumeLive(approved);
    const d = resumeLive(denied);

    await a.loop.execute(a.ctx);
    await d.loop.execute(d.ctx);
    await sweepLive(LATE).run();

    expect(approved.risky.run).not.toHaveBeenCalled();
    expect(denied.risky.run).not.toHaveBeenCalled();
    expect(failedCodes(a.rows)).toEqual(["approval_not_granted"]);
    expect(failedCodes(d.rows)).toEqual(["approval_denied"]);
    expect(await statusOf(idOf(approved.runId))).toBe("approved");
    expect(await statusOf(idOf(denied.runId))).toBe("denied");
  });

  it("does not run a call whose row is missing or sits in another workspace", async () => {
    const missing = await pauseLive();
    await pool.query("delete from public.approvals where id = $1", [idOf(missing.runId)]);
    const foreign = await pauseLive();
    // Move the row to the other workspace (its run and agent too, as the foreign keys require).
    const otherRun = await newRun(OTHER_WS, OTHER_AGENT);
    await pool.query(
      "update public.approvals set workspace_id = $2, run_id = $3, agent_id = $4 where id = $1",
      [idOf(foreign.runId), OTHER_WS, otherRun, OTHER_AGENT],
    );

    for (const world of [missing, foreign]) {
      const b = resumeLive(world);
      await b.loop.execute(b.ctx);
      expect(world.risky.run).not.toHaveBeenCalled();
      expect(failedCodes(b.rows)).toEqual(["approval_not_granted"]);
    }
  });

  it("writes one decided event per approval when two sweepers run at once (invariant 5)", async () => {
    const worlds: Live[] = [];
    for (let i = 0; i < 5; i += 1) worlds.push(await pauseLive(EARLY));
    const a = sweepLive(EARLY_NOW);
    const b = sweepLive(EARLY_NOW);

    const [x, y] = await Promise.all([a.run(), b.run()]);

    expect(x + y).toBe(5);
    for (const world of worlds) {
      expect(await statusOf(idOf(world.runId))).toBe("rejected");
      const decided = await decidedInDb(world.runId);
      expect(decided).toHaveLength(1);
      expect(decided[0]?.payload).toMatchObject({
        approval_id: idOf(world.runId),
        outcome: "expired",
        decided_by: "timeout",
      });
    }
    expect(a.wake.mock.calls.length + b.wake.mock.calls.length).toBe(5);
  });

  it("writes one decided event when a sweeper and the resume check race on the same approval (invariant 5)", async () => {
    const worlds: Live[] = [];
    for (let i = 0; i < 5; i += 1) worlds.push(await pauseLive(EARLY));
    for (const world of worlds) world.clock.now = EARLY_NOW;
    const sweep = sweepLive(EARLY_NOW);
    const resumes = worlds.map((world) => resumeLive(world));

    await Promise.all([sweep.run(), ...resumes.map((b) => b.loop.execute(b.ctx))]);

    for (const [index, world] of worlds.entries()) {
      expect(world.risky.run).not.toHaveBeenCalled();
      expect(failedCodes(resumes[index]?.rows ?? [])).toEqual(["approval_expired"]);
      expect(await statusOf(idOf(world.runId))).toBe("rejected");
      expect(await decidedInDb(world.runId)).toHaveLength(1);
    }
  });

  it("refuses to update or delete the run_events written for these approvals (append-only)", async () => {
    const world = await pauseLive();
    world.clock.now = NOW;
    const b = resumeLive(world);
    await b.loop.execute(b.ctx);
    const before = await dbEvents(world.runId);
    const types = before.map((row) => row.type);
    expect(types).toEqual(expect.arrayContaining(["approval.requested", "approval.decided"]));

    for (const type of ["approval.requested", "approval.decided"]) {
      await expect(
        pool.query(
          "update public.run_events set payload = '{}'::jsonb where run_id = $1 and type = $2",
          [world.runId, type],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "update public.run_events set type = 'run.completed' where run_id = $1 and type = $2",
          [world.runId, type],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query("delete from public.run_events where run_id = $1 and type = $2", [
          world.runId,
          type,
        ]),
      ).rejects.toThrow();
    }
    expect(await dbEvents(world.runId)).toEqual(before);
  });
});
