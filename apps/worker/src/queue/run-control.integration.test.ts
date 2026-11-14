// AGO-86 functional acceptance (tester): the SQL of run control against the real local Postgres, not the in-memory
// fakes: markStopped, resumeRun and wakeRunAfterExpiry refusing a stop request, rejectPendingForRun, and the
// control flags in the Postgres checkpoint store. It skips itself when the shared local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-86 --wait-min 120   (and release after).
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgCheckpointStore } from "../agent/checkpoint-store.js";
import { createPgApprovalStore } from "../approvals/index.js";
import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";
import { sweepControlRequests, type ControlSweepDeps } from "./run-control-sweep.js";
import { createPgRunStore, RUN_STATUS } from "./index.js";

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

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const HASH = "a".repeat(64);

describe.skipIf(!live)("run control SQL (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;

  const newRun = async (
    runStatus: string,
    workspaceId = WORKSPACE,
    agentId = AGENT,
  ): Promise<string> => {
    const id = randomUUID();
    await pool.query(
      "insert into public.runs (id, workspace_id, agent_id, status) values ($1, $2, $3, $4)",
      [id, workspaceId, agentId, runStatus],
    );
    return id;
  };
  const status = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>("select status from public.runs where id = $1", [id]))
      .rows[0]?.status ?? "missing";
  const flag = (workspaceId: string, runId: string, column: string) =>
    pool.query(
      `insert into private.run_checkpoints (workspace_id, run_id, ${column}) values ($1, $2, now())
       on conflict (workspace_id, run_id) do update set ${column} = now()`,
      [workspaceId, runId],
    );
  const newApproval = async (
    runId: string,
    approvalStatus: string,
    options: { workspaceId?: string; agentId?: string; consumed?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await pool.query(
      `insert into public.approvals (id, workspace_id, run_id, agent_id, action, payload_hash, status, expires_at, consumed_at)
       values ($1, $2, $3, $4, 'risky', $5, $6, now() + interval '1 hour', $7)`,
      [
        id,
        options.workspaceId ?? WORKSPACE,
        runId,
        options.agentId ?? AGENT,
        HASH,
        approvalStatus,
        options.consumed === true ? new Date() : null,
      ],
    );
    return id;
  };
  const approvalStatus = async (id: string): Promise<string> =>
    (
      await pool.query<{ status: string }>("select status from public.approvals where id = $1", [
        id,
      ])
    ).rows[0]?.status ?? "missing";

  /** Rows of this run that still carry a stop request. */
  const flagRows = async (runId: string): Promise<number> =>
    (
      await pool.query(
        `select 1 from private.run_checkpoints where run_id = $1 and stop_requested_at is not null`,
        [runId],
      )
    ).rowCount ?? 0;
  const stopEvents = async (runId: string): Promise<number> =>
    (
      await pool.query(
        `select 1 from public.run_events where run_id = $1 and type = 'run.stopped'`,
        [runId],
      )
    ).rowCount ?? 0;
  const emitStopped = async (runId: string): Promise<void> => {
    await createPgRunEventStore(pool).insert({
      workspace_id: WORKSPACE,
      run_id: runId,
      type: "run.stopped",
      payload: { stopped_by: "human", reason: "stopped_by_human" },
    });
  };
  const sweepDeps = (db: pg.Pool): ControlSweepDeps => ({
    runs: createPgRunStore(db),
    approvals: createPgApprovalStore(db),
    checkpoints: createPgCheckpointStore(db),
    events: createPgRunEventStore(db),
    control: { resumeRun: () => Promise.resolve("not_paused" as const) },
    logger: createLogger({ level: "silent" }),
    batchSize: 100,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
    for (const [workspace, agent] of [
      [WORKSPACE, AGENT],
      [OTHER_WORKSPACE, OTHER_AGENT],
    ] as const) {
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-86 test')", [
        workspace,
      ]);
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
        [agent, workspace],
      );
    }
  });

  afterAll(async () => {
    const ids = [WORKSPACE, OTHER_WORKSPACE];
    await pool.query("delete from public.approvals where workspace_id = any($1)", [ids]);
    await pool.query("delete from private.run_checkpoints where workspace_id = any($1)", [ids]);
    // run_events is append-only: clean up the way scripts/run-events-teardown.mjs does (as the other integration tests).
    await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      delete from public.agents where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      delete from public.workspaces where id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      commit;`);
    await pool.end();
  });

  describe("markStopped: stop is final", () => {
    it("moves a queued, running or paused run to stopped and sets finished_at", async () => {
      const store = createPgRunStore(pool);
      for (const from of [RUN_STATUS.queued, RUN_STATUS.running, RUN_STATUS.paused]) {
        const runId = await newRun(from);
        await expect(
          store.markStopped({ workspaceId: WORKSPACE, runId }, ["queued", "running", "paused"]),
        ).resolves.toBe(true);
        expect(await status(runId)).toBe(RUN_STATUS.stopped);
        const finished = await pool.query<{ finished_at: Date | null }>(
          "select finished_at from public.runs where id = $1",
          [runId],
        );
        expect(finished.rows[0]?.finished_at).not.toBeNull();
      }
    });

    it("only moves from the statuses the caller names, and never leaves a finished run", async () => {
      const store = createPgRunStore(pool);
      const running = await newRun(RUN_STATUS.running);
      await expect(
        store.markStopped({ workspaceId: WORKSPACE, runId: running }, ["queued", "paused"]),
      ).resolves.toBe(false);
      expect(await status(running)).toBe(RUN_STATUS.running);

      for (const done of [RUN_STATUS.succeeded, RUN_STATUS.failed]) {
        const runId = await newRun(done);
        await expect(
          store.markStopped({ workspaceId: WORKSPACE, runId }, ["queued", "running", "paused"]),
        ).resolves.toBe(false);
        expect(await status(runId)).toBe(done);
      }
    });

    it("a second stop moves nothing, and a run in another workspace is untouched", async () => {
      const store = createPgRunStore(pool);
      const runId = await newRun(RUN_STATUS.paused);
      const ref = { workspaceId: WORKSPACE, runId };
      await expect(store.markStopped(ref, ["queued", "paused"])).resolves.toBe(true);
      await expect(store.markStopped(ref, ["queued", "paused"])).resolves.toBe(false);

      const other = await newRun(RUN_STATUS.paused);
      await expect(
        store.markStopped({ workspaceId: OTHER_WORKSPACE, runId: other }, ["paused"]),
      ).resolves.toBe(false);
      expect(await status(other)).toBe(RUN_STATUS.paused);
    });

    it("two concurrent stops make exactly one transition", async () => {
      const store = createPgRunStore(pool);
      for (let round = 0; round < 5; round += 1) {
        const runId = await newRun(RUN_STATUS.paused);
        const ref = { workspaceId: WORKSPACE, runId };
        const results = await Promise.all([
          store.markStopped(ref, ["paused"]),
          store.markStopped(ref, ["paused"]),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      }
    });

    it("a stopped run can never be resumed or woken", async () => {
      const store = createPgRunStore(pool);
      const runId = await newRun(RUN_STATUS.stopped);
      const ref = { workspaceId: WORKSPACE, runId };
      await expect(store.resumeRun(ref)).resolves.toBe(false);
      await expect(store.wakeRunAfterExpiry(ref)).resolves.toBe(false);
      expect(await status(runId)).toBe(RUN_STATUS.stopped);
    });
  });

  describe("a stop request beats resume and wake before it is finalized", () => {
    it("resumeRun resumes a paused run, but refuses one with a stop request", async () => {
      const store = createPgRunStore(pool);
      const plain = await newRun(RUN_STATUS.paused);
      await expect(store.resumeRun({ workspaceId: WORKSPACE, runId: plain })).resolves.toBe(true);
      expect(await status(plain)).toBe(RUN_STATUS.queued);

      const stopping = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, stopping, "stop_requested_at");
      await expect(store.resumeRun({ workspaceId: WORKSPACE, runId: stopping })).resolves.toBe(
        false,
      );
      expect(await status(stopping)).toBe(RUN_STATUS.paused);
    });

    it("wakeRunAfterExpiry refuses a run with a stop request, as it does for a pause request", async () => {
      const store = createPgRunStore(pool);
      const stopping = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, stopping, "stop_requested_at");
      await expect(
        store.wakeRunAfterExpiry({ workspaceId: WORKSPACE, runId: stopping }),
      ).resolves.toBe(false);
      expect(await status(stopping)).toBe(RUN_STATUS.paused);
    });
  });

  describe("rejectPendingForRun: stop closes pending approvals", () => {
    it("rejects this run's pending approvals and returns them with their payload hash", async () => {
      const store = createPgApprovalStore(pool);
      const runId = await newRun(RUN_STATUS.paused);
      const a = await newApproval(runId, "pending");
      const b = await newApproval(runId, "pending");

      const closed = await store.rejectPendingForRun({ workspaceId: WORKSPACE, runId });

      expect(closed.map((row) => row.approvalId).sort()).toEqual([a, b].sort());
      expect(closed.every((row) => row.payloadHash === HASH && row.runId === runId)).toBe(true);
      expect(await approvalStatus(a)).toBe("rejected");
      expect(await approvalStatus(b)).toBe("rejected");
    });

    it("never writes approved or denied, and leaves decided and consumed approvals alone", async () => {
      const store = createPgApprovalStore(pool);
      const runId = await newRun(RUN_STATUS.paused);
      const approved = await newApproval(runId, "approved");
      const consumed = await newApproval(runId, "pending", { consumed: true });
      const pending = await newApproval(runId, "pending");

      await store.rejectPendingForRun({ workspaceId: WORKSPACE, runId });

      expect(await approvalStatus(approved)).toBe("approved");
      expect(await approvalStatus(consumed)).toBe("pending");
      expect(await approvalStatus(pending)).toBe("rejected");
    });

    it("is scoped to the run and the workspace, and a second call finds nothing", async () => {
      const store = createPgApprovalStore(pool);
      const runId = await newRun(RUN_STATUS.paused);
      const mine = await newApproval(runId, "pending");
      const siblingRun = await newRun(RUN_STATUS.paused);
      const sibling = await newApproval(siblingRun, "pending");
      const otherRun = await newRun(RUN_STATUS.paused, OTHER_WORKSPACE, OTHER_AGENT);
      const other = await newApproval(otherRun, "pending", {
        workspaceId: OTHER_WORKSPACE,
        agentId: OTHER_AGENT,
      });

      await store.rejectPendingForRun({ workspaceId: WORKSPACE, runId });
      // the right run id with the wrong workspace closes nothing
      await expect(
        store.rejectPendingForRun({ workspaceId: OTHER_WORKSPACE, runId: siblingRun }),
      ).resolves.toEqual([]);

      expect(await approvalStatus(mine)).toBe("rejected");
      expect(await approvalStatus(sibling)).toBe("pending");
      expect(await approvalStatus(other)).toBe("pending");
      await expect(store.rejectPendingForRun({ workspaceId: WORKSPACE, runId })).resolves.toEqual(
        [],
      );
    });
  });

  describe("the Postgres checkpoint store reads and clears the control flags", () => {
    it("readControl reports pause and stop requests for that run only", async () => {
      const store = createPgCheckpointStore(pool);
      const runId = await newRun(RUN_STATUS.running);
      const ref = { workspaceId: WORKSPACE, runId };
      await expect(store.readControl(ref)).resolves.toEqual({
        pauseRequested: false,
        stopRequested: false,
      });

      await flag(WORKSPACE, runId, "pause_requested_at");
      await expect(store.readControl(ref)).resolves.toEqual({
        pauseRequested: true,
        stopRequested: false,
      });
      await flag(WORKSPACE, runId, "stop_requested_at");
      await expect(store.readControl(ref)).resolves.toEqual({
        pauseRequested: true,
        stopRequested: true,
      });
      await expect(store.readControl({ workspaceId: OTHER_WORKSPACE, runId })).resolves.toEqual({
        pauseRequested: false,
        stopRequested: false,
      });
    });

    it("listControlRequests lists stop and resume requests, and clearResumeRequest forgets only the resume", async () => {
      const store = createPgCheckpointStore(pool);
      const stopRun = await newRun(RUN_STATUS.paused);
      const resumeRun = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, stopRun, "stop_requested_at");
      await flag(WORKSPACE, resumeRun, "resume_requested_at");

      const listed = await store.listControlRequests(1_000);
      const byRun = new Map(listed.map((entry) => [entry.runId, entry]));
      expect(byRun.get(stopRun)).toMatchObject({ stopRequested: true, resumeRequested: false });
      expect(byRun.get(resumeRun)).toMatchObject({ stopRequested: false, resumeRequested: true });

      await store.clearResumeRequest({ workspaceId: WORKSPACE, runId: resumeRun });
      await store.clearResumeRequest({ workspaceId: WORKSPACE, runId: stopRun });
      const after = new Map((await store.listControlRequests(1_000)).map((e) => [e.runId, e]));
      expect(after.has(resumeRun)).toBe(false);
      expect(after.get(stopRun)).toMatchObject({ stopRequested: true });
    });
  });

  describe("round 2 (C2): listControlRequests joins runs", () => {
    it("lists a stop for queued, paused and stopped runs only, and a resume for queued or paused only", async () => {
      const store = createPgCheckpointStore(pool);
      const wanted = new Map<string, boolean>();
      for (const [state, column, listed] of [
        ["queued", "stop_requested_at", true],
        ["paused", "stop_requested_at", true],
        ["stopped", "stop_requested_at", true],
        ["running", "stop_requested_at", false],
        ["succeeded", "stop_requested_at", false],
        ["failed", "stop_requested_at", false],
        ["paused", "resume_requested_at", true],
        ["running", "resume_requested_at", false],
        ["succeeded", "resume_requested_at", false],
      ] as const) {
        const runId = await newRun(state);
        await flag(WORKSPACE, runId, column);
        wanted.set(runId, listed);
      }
      const listed = new Set((await store.listControlRequests(10_000)).map((e) => e.runId));
      for (const [runId, isListed] of wanted) expect(listed.has(runId)).toBe(isListed);
    });

    it("clearStaleControlRequests forgets the requests of finished runs and nothing else", async () => {
      const store = createPgCheckpointStore(pool);
      const done = await newRun(RUN_STATUS.succeeded);
      const failed = await newRun(RUN_STATUS.failed);
      const live = await newRun(RUN_STATUS.paused);
      for (const runId of [done, failed, live]) await flag(WORKSPACE, runId, "stop_requested_at");

      await store.clearStaleControlRequests();

      expect(await store.readControl({ workspaceId: WORKSPACE, runId: done })).toMatchObject({
        stopRequested: false,
      });
      expect(await store.readControl({ workspaceId: WORKSPACE, runId: failed })).toMatchObject({
        stopRequested: false,
      });
      expect(await store.readControl({ workspaceId: WORKSPACE, runId: live })).toMatchObject({
        stopRequested: true,
      });
    });

    it("a live stop is processed behind more than 100 stale stop requests", async () => {
      const stale = await pool.query<{ id: string }>(
        `insert into public.runs (id, workspace_id, agent_id, status)
         select gen_random_uuid(), $1, $2, 'failed' from generate_series(1, 130) returning id`,
        [WORKSPACE, AGENT],
      );
      for (const { id } of stale.rows) await flag(WORKSPACE, id, "stop_requested_at");
      const live = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, live, "stop_requested_at"); // flagged last: it sits behind every stale row

      await sweepControlRequests(sweepDeps(pool));

      expect(await status(live)).toBe(RUN_STATUS.stopped);
      expect(await stopEvents(live)).toBe(1);
      expect(await flagRows(live)).toBe(0);
      expect(await flagRows(stale.rows[0]?.id ?? "")).toBe(0); // forgotten, not stopped
    });
  });

  describe("round 2 (C1): an unfinished stop is finished once", () => {
    it("finishStopTail writes the event when it is missing, then drops the flag", async () => {
      const store = createPgCheckpointStore(pool);
      const runId = await newRun(RUN_STATUS.stopped);
      await flag(WORKSPACE, runId, "stop_requested_at");
      const seen: boolean[] = [];

      await expect(
        store.finishStopTail({ workspaceId: WORKSPACE, runId }, (isWritten) => {
          seen.push(isWritten);
          return Promise.resolve();
        }),
      ).resolves.toBe(true);

      expect(seen).toEqual([false]);
      expect(await flagRows(runId)).toBe(0);
    });

    it("finishStopTail reports an existing run.stopped, so the event is not written twice", async () => {
      const store = createPgCheckpointStore(pool);
      const runId = await newRun(RUN_STATUS.stopped);
      await flag(WORKSPACE, runId, "stop_requested_at");
      await emitStopped(runId);
      const seen: boolean[] = [];

      await store.finishStopTail({ workspaceId: WORKSPACE, runId }, (isWritten) => {
        seen.push(isWritten);
        return Promise.resolve();
      });

      expect(seen).toEqual([true]);
      expect(await flagRows(runId)).toBe(0);
    });

    it("finishStopTail does nothing for a run that is not stopped or has no flag", async () => {
      const store = createPgCheckpointStore(pool);
      const paused = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, paused, "stop_requested_at");
      const noFlag = await newRun(RUN_STATUS.stopped);
      let called = 0;
      const write = () => {
        called += 1;
        return Promise.resolve();
      };

      await expect(
        store.finishStopTail({ workspaceId: WORKSPACE, runId: paused }, write),
      ).resolves.toBe(false);
      await expect(
        store.finishStopTail({ workspaceId: WORKSPACE, runId: noFlag }, write),
      ).resolves.toBe(false);
      await expect(
        store.finishStopTail({ workspaceId: OTHER_WORKSPACE, runId: paused }, write),
      ).resolves.toBe(false);

      expect(called).toBe(0);
      expect(await flagRows(paused)).toBe(1);
    });

    it("a failing write keeps the flag and rethrows; the next call completes it", async () => {
      const store = createPgCheckpointStore(pool);
      const runId = await newRun(RUN_STATUS.stopped);
      await flag(WORKSPACE, runId, "stop_requested_at");

      await expect(
        store.finishStopTail({ workspaceId: WORKSPACE, runId }, () =>
          Promise.reject(new Error("event store is down")),
        ),
      ).rejects.toThrow("event store is down");
      expect(await flagRows(runId)).toBe(1);

      await expect(
        store.finishStopTail({ workspaceId: WORKSPACE, runId }, () => Promise.resolve()),
      ).resolves.toBe(true);
      expect(await flagRows(runId)).toBe(0);
    });

    it("two workers finishing the same tail at once: exactly one does it", async () => {
      const store = createPgCheckpointStore(pool);
      for (let round = 0; round < 3; round += 1) {
        const runId = await newRun(RUN_STATUS.stopped);
        await flag(WORKSPACE, runId, "stop_requested_at");
        let writes = 0;
        const slowWrite = async () => {
          writes += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
        };
        const results = await Promise.all([
          store.finishStopTail({ workspaceId: WORKSPACE, runId }, slowWrite),
          store.finishStopTail({ workspaceId: WORKSPACE, runId }, slowWrite),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(writes).toBe(1);
      }
    });

    it("end to end: a failed run.stopped write, then the next sweep writes exactly one and drops the flag", async () => {
      const runId = await newRun(RUN_STATUS.paused);
      await flag(WORKSPACE, runId, "stop_requested_at");
      const real = createPgRunEventStore(pool);
      let failures = 1;
      const deps = {
        ...sweepDeps(pool),
        events: {
          insert: (row: RunEventRow) => {
            if (row.type === "run.stopped" && row.run_id === runId && failures > 0) {
              failures -= 1;
              return Promise.reject(new Error("event store is down"));
            }
            return real.insert(row);
          },
        },
      };

      await sweepControlRequests(deps);
      expect(await status(runId)).toBe(RUN_STATUS.stopped);
      expect(await stopEvents(runId)).toBe(0);
      expect(await flagRows(runId)).toBe(1);

      await sweepControlRequests(deps);
      expect(await stopEvents(runId)).toBe(1);
      expect(await flagRows(runId)).toBe(0);

      await sweepControlRequests(deps);
      expect(await stopEvents(runId)).toBe(1);
    });
  });
});
