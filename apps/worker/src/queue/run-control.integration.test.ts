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
    await pool.query("delete from public.runs where workspace_id = any($1)", [ids]);
    await pool.query("delete from public.agents where workspace_id = any($1)", [ids]);
    await pool.query("delete from public.workspaces where id = any($1)", [ids]);
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
});
