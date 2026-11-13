// AGO-30 integration test: the real Postgres checkpoint store, run store and queue, with a scripted fake
// model (no network, no API key). A run is paused by a human while a tool runs, then resumed, and must
// finish without running the tool again. It skips itself when the shared local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-30 ... release AGO-30
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createContextBuilder, createPgRunContextSource } from "../context/index.js";
import { createPgRunEventStore } from "../events/index.js";
import { createLogger } from "../logger.js";
import {
  createJobQueue,
  createPgRunStore,
  createRunControl,
  runQueueNames,
  RUN_STATUS,
  type HumanActor,
  type JobQueue,
} from "../queue/index.js";
import { createAgentLoop } from "./agent-loop.js";
import { CheckpointUnreadableError, createPgCheckpointStore } from "./checkpoint-store.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
import type { PolicyHook } from "./policy-hook.js";
import type { ErrorTracker } from "../sentry.js";
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

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const HUMAN: HumanActor = { kind: "human", userId: randomUUID() };
const QUEUE_NAME = `ago30-${randomUUID().slice(0, 8)}`;
const FAST_RETRY = {
  retryLimit: 1,
  retryDelaySeconds: 1,
  retryDelayMaxSeconds: 2,
  expireInSeconds: 60,
} as const;
const usage = { inputTokens: 10, outputTokens: 5 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(150);
  }
}

describe.skipIf(!live)(
  "run checkpoint, pause and resume (live database)",
  { timeout: 60_000 },
  () => {
    let pool: pg.Pool;
    const queues: JobQueue[] = [];
    const tracker: ErrorTracker = {
      isEnabled: false,
      captureException: () => undefined,
      addBreadcrumb: () => undefined,
      close: () => Promise.resolve(true),
    };
    const allowAll: PolicyHook = {
      check: () => Promise.resolve({ decision: "allow", reasonCode: "test_allow" }),
    };

    const newRun = async (workspaceId = WORKSPACE, agentId = AGENT): Promise<string> => {
      const id = randomUUID();
      await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
        id,
        workspaceId,
        agentId,
      ]);
      return id;
    };
    const status = async (id: string): Promise<string> =>
      (await pool.query<{ status: string }>("select status from public.runs where id = $1", [id]))
        .rows[0]?.status ?? "missing";
    const eventTypes = async (id: string): Promise<string[]> =>
      (
        await pool.query<{ type: string }>(
          "select type from public.run_events where run_id = $1 order by seq",
          [id],
        )
      ).rows.map((row) => row.type);
    const checkpointRows = async (id: string): Promise<number> =>
      (await pool.query("select 1 from private.run_checkpoints where run_id = $1", [id]))
        .rowCount ?? 0;

    const purgeJobs = () =>
      pool
        .query("delete from pgboss.job where name = any($1)", [
          Object.values(runQueueNames(QUEUE_NAME)),
        ])
        .catch(() => undefined);

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
      for (const [workspace, agent] of [
        [WORKSPACE, AGENT],
        [OTHER_WORKSPACE, OTHER_AGENT],
      ] as const) {
        await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-30 test')", [
          workspace,
        ]);
        await pool.query(
          "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
          [agent, workspace],
        );
      }
    });

    afterEach(async () => {
      await Promise.all(queues.splice(0).map((queue) => queue.stop()));
      await purgeJobs();
    });

    afterAll(async () => {
      const ids = `'${WORKSPACE}', '${OTHER_WORKSPACE}'`;
      // run_events is append-only: clean up the way scripts/run-events-teardown.mjs does.
      await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id in (${ids});
      delete from public.agents where workspace_id in (${ids});
      delete from public.workspaces where id in (${ids});
      commit;`);
      await purgeJobs();
      await pool.end();
    });

    describe("the Postgres checkpoint store", () => {
      const state = (over: Partial<RunCheckpointState> = {}): RunCheckpointState => ({
        version: 1,
        steps: 2,
        tokens: 30,
        completedCalls: 1,
        lastFingerprint: "abc",
        repeatCount: 1,
        reportedDropped: 0,
        history: [{ source: "tool:alpha#t1", content: "status: ok" }],
        step: null,
        ...over,
      });

      it("saves, replaces and loads a state, and clears it", async () => {
        const store = createPgCheckpointStore(pool);
        const runId = await newRun();
        const ref = { workspaceId: WORKSPACE, runId };

        await expect(store.load(ref)).resolves.toEqual({ state: null });
        await store.save(ref, state());
        await store.save(ref, state({ steps: 3 }));
        expect((await store.load(ref)).state?.steps).toBe(3);

        await store.clear(ref);
        expect(await checkpointRows(runId)).toBe(0);
      });

      it("only records a pause for a queued or running run in the same workspace", async () => {
        const store = createPgCheckpointStore(pool);
        const queued = await newRun();
        const finished = await newRun();
        await pool.query("update public.runs set status = 'succeeded' where id = $1", [finished]);
        const foreign = await newRun(OTHER_WORKSPACE, OTHER_AGENT);
        const inA = (runId: string) => ({ workspaceId: WORKSPACE, runId });

        await expect(store.requestPause(inA(queued))).resolves.toBe(true);
        await expect(store.isPauseRequested(inA(queued))).resolves.toBe(true);
        await expect(store.requestPause(inA(finished))).resolves.toBe(false);
        // Workspace A cannot name workspace B's run.
        await expect(store.requestPause(inA(foreign))).resolves.toBe(false);
        await expect(store.isPauseRequested(inA(foreign))).resolves.toBe(false);
        expect(await checkpointRows(foreign)).toBe(0);

        await store.clearPause(inA(queued));
        await expect(store.isPauseRequested(inA(queued))).resolves.toBe(false);
      });

      it("keeps the pause request when the state is saved, and the state when a pause is requested", async () => {
        const store = createPgCheckpointStore(pool);
        const runId = await newRun();
        const ref = { workspaceId: WORKSPACE, runId };

        await store.requestPause(ref);
        await store.save(ref, state());
        await expect(store.isPauseRequested(ref)).resolves.toBe(true);
        await store.requestPause(ref);
        expect((await store.load(ref)).state?.steps).toBe(2);
      });

      it("refuses to read a state it does not understand", async () => {
        const store = createPgCheckpointStore(pool);
        const runId = await newRun();
        await pool.query(
          `insert into private.run_checkpoints (workspace_id, run_id, state) values ($1, $2, '{"version":99}')`,
          [WORKSPACE, runId],
        );

        await expect(store.load({ workspaceId: WORKSPACE, runId })).rejects.toBeInstanceOf(
          CheckpointUnreadableError,
        );
      });
    });

    it("pauses at a human's request, then resumes and finishes without running the tool again", async () => {
      const requests: ModelRequest[] = [];
      const checkpoints = createPgCheckpointStore(pool);
      const runId = await newRun();
      const ref = { workspaceId: WORKSPACE, runId };
      const run = vi.fn(async () => {
        // A human asks for the pause while the tool runs: it takes effect before the next model call.
        await checkpoints.requestPause(ref);
        return "alpha output";
      });
      const alpha: AgentTool = {
        name: "alpha",
        description: "alpha tool",
        tier: 0,
        inputSchema: z.looseObject({}),
        modelInputSchema: { type: "object" },
        execute: run,
      };
      const provider: ModelProvider = {
        complete: (request) => {
          requests.push(request);
          const seen = JSON.stringify(request.messages).includes("status: ok");
          const response: ModelResponse = seen
            ? { text: "Finished.", toolCalls: [], usage }
            : { text: "", toolCalls: [{ id: "toolu_1", name: "alpha", input: {} }], usage };
          return Promise.resolve(response);
        },
      };
      const logger = createLogger({ level: "silent" });
      const queue = createJobQueue({
        connectionString: DATABASE_URL,
        logger,
        errorTracker: tracker,
        executor: createAgentLoop({
          toolOffer: offerAllTools,
          provider,
          contextBuilder: createContextBuilder({ source: createPgRunContextSource(pool), logger }),
          tools: createToolRegistry([alpha]),
          policy: allowAll,
          checkpoints,
        }),
        queueName: QUEUE_NAME,
        retryPolicy: FAST_RETRY,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 10_000,
        concurrency: 2,
      });
      queues.push(queue);
      await queue.start();
      const control = createRunControl({
        runs: createPgRunStore(pool),
        checkpoints,
        queue,
        events: createPgRunEventStore(pool),
        logger,
      });

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await status(runId)) === RUN_STATUS.paused);

      // Paused: one model call was made and has finished, the tool ran once, the state is saved.
      expect(requests).toHaveLength(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(await checkpointRows(runId)).toBe(1);
      expect(await eventTypes(runId)).toContain("run.paused");
      await sleep(1_000);
      expect(requests).toHaveLength(1); // nothing starts a model call while it is paused

      await expect(control.resumeRun(ref, HUMAN)).resolves.toBe("resumed");
      await expect(control.resumeRun(ref, HUMAN)).resolves.toBe("not_paused");
      await waitFor(async () => (await status(runId)) === RUN_STATUS.succeeded);

      expect(run).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2); // the final answer only
      expect(await checkpointRows(runId)).toBe(0);
      const types = await eventTypes(runId);
      expect(types).toContain("run.resumed");
      expect(types).toContain("run.recovered");
      expect(types.filter((t) => t === "run.created")).toHaveLength(1); // the resume adds none
      expect(types.at(-1)).toBe("run.completed");
    });
  },
);
