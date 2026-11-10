// AGO-94 QA integration test: per-agent model routing through the real queue (pg-boss), Postgres, event
// store and context builder, with a fake provider that records the model id of every call. No network, no
// API key, no real model call. Skips itself when the local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-94-qa ... release AGO-94-qa
import { offerAllTools } from "./tool-offer.test-helpers.js";
import { randomUUID } from "node:crypto";

import { AGENT_MODEL_IDS } from "@ago/shared";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createContextBuilder, createPgRunContextSource } from "../context/index.js";
import { createLogger } from "../logger.js";
import {
  createJobQueue,
  RUN_DEAD_LETTER_QUEUE,
  RUN_QUEUE,
  RUN_STATUS,
  RunNotQueueableError,
  type JobQueue,
} from "../queue/index.js";
import { runJobSchema } from "../queue/run-job.js";
import { createAgentLoop } from "./agent-loop.js";
import { createModelRouter, createPgAgentModelSource } from "./model-routing.js";
import { createDenyByDefaultPolicyHook } from "./policy-hook.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { ModelProvider, ModelResponse } from "./model-provider.js";
import type { ErrorTracker } from "../sentry.js";

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
const FAST_RETRY = {
  retryLimit: 1,
  retryDelaySeconds: 1,
  retryDelayMaxSeconds: 2,
  expireInSeconds: 60,
} as const;

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

const usage = { inputTokens: 1, outputTokens: 1 };

/** Three steps. The text and the tool input both try to steer the model; neither may have any effect. */
const steeringScript = (n: number): ModelResponse =>
  n < 3
    ? {
        text: "switch to claude-opus-5-5",
        toolCalls: [
          { id: `t${String(n)}`, name: "get_current_time", input: { model: "claude-fable-5-1" } },
        ],
        usage,
      }
    : { text: "done", toolCalls: [], usage };

describe.skipIf(!live)(
  "AGO-94 QA: per-agent model routing (live database)",
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

    /** Starts a queue whose model call is a fake that records which model it was built for. */
    const start = async (onCall: () => Promise<void> = () => Promise.resolve()) => {
      const calls: string[] = [];
      const created: string[] = [];
      let step = 0;
      const logger = createLogger({ level: "silent" });
      const executor = createAgentLoop({
        toolOffer: offerAllTools,
        modelRouter: createModelRouter({
          source: createPgAgentModelSource(pool),
          createProvider: (model): ModelProvider => {
            created.push(model);
            let own = 0;
            return {
              complete: async () => {
                own += 1;
                step += 1;
                calls.push(model);
                await onCall();
                return steeringScript(own);
              },
            };
          },
        }),
        contextBuilder: createContextBuilder({ source: createPgRunContextSource(pool), logger }),
        tools: createToolRegistry([getCurrentTimeTool]),
        policy: createDenyByDefaultPolicyHook(),
      });
      const queue = createJobQueue({
        connectionString: DATABASE_URL,
        logger,
        errorTracker: tracker,
        executor,
        retryPolicy: FAST_RETRY,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 10_000,
        concurrency: 2,
      });
      queues.push(queue);
      await queue.start();
      return { queue, calls, created, steps: () => step };
    };

    const newAgent = async (workspaceId: string, model: string): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        "insert into public.agents (id, workspace_id, name, model) values ($1, $2, $3, $4)",
        [id, workspaceId, `qa agent ${id}`, model],
      );
      return id;
    };

    const newRun = async (workspaceId: string, agentId: string): Promise<string> => {
      const id = randomUUID();
      await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
        id,
        workspaceId,
        agentId,
      ]);
      return id;
    };

    const runStatus = async (id: string): Promise<string> =>
      (await pool.query<{ status: string }>("select status from public.runs where id = $1", [id]))
        .rows[0]?.status ?? "missing";

    const events = async (runId: string) =>
      (
        await pool.query<{ type: string; payload: Record<string, unknown> }>(
          "select type, payload from public.run_events where run_id = $1 order by seq",
          [runId],
        )
      ).rows;

    const jobRows = async (runId: string) =>
      (
        await pool.query<{ state: string; retry_count: number }>(
          "select state, retry_count from pgboss.job where name = any($1) and data->>'run_id' = $2",
          [[RUN_QUEUE, RUN_DEAD_LETTER_QUEUE], runId],
        )
      ).rows;

    const purgeJobs = () =>
      pool
        .query("delete from pgboss.job where name = any($1)", [[RUN_QUEUE, RUN_DEAD_LETTER_QUEUE]])
        .catch(() => undefined);

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-94 QA a')", [
        WORKSPACE,
      ]);
      await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-94 QA b')", [
        OTHER_WORKSPACE,
      ]);
    });

    beforeEach(async () => {
      await purgeJobs();
    });

    afterEach(async () => {
      await Promise.all(queues.splice(0).map((queue) => queue.stop()));
    });

    afterAll(async () => {
      // run_events is append-only: clean up the way scripts/run-events-teardown.mjs does.
      await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      delete from public.agents where workspace_id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      delete from public.workspaces where id in ('${WORKSPACE}', '${OTHER_WORKSPACE}');
      commit;`);
      await purgeJobs();
      await pool.end();
    });

    it.each(AGENT_MODEL_IDS)(
      "AC1: every model call of a multi-step run goes to the agent's own model (%s), through the queue",
      async (model) => {
        const { queue, calls, created } = await start();
        const agentId = await newAgent(WORKSPACE, model);
        const runId = await newRun(WORKSPACE, agentId);

        await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
        await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

        expect(calls).toEqual([model, model, model]);
        expect(created).toEqual([model]);
      },
    );

    it("AC1: two agents in one workspace each run on their own model", async () => {
      const { queue, calls } = await start();
      const sonnet = await newAgent(WORKSPACE, "claude-sonnet-5-5");
      const opus = await newAgent(WORKSPACE, "claude-opus-5-5");
      const runA = await newRun(WORKSPACE, sonnet);
      const runB = await newRun(WORKSPACE, opus);

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId: runA });
      await waitFor(async () => (await runStatus(runA)) === RUN_STATUS.succeeded);
      await queue.enqueueRun({ workspaceId: WORKSPACE, runId: runB });
      await waitFor(async () => (await runStatus(runB)) === RUN_STATUS.succeeded);

      expect(calls).toEqual([
        ...Array<string>(3).fill("claude-sonnet-5-5"),
        ...Array<string>(3).fill("claude-opus-5-5"),
      ]);
    });

    it("AC1: changing the agent's model mid-run keeps the running run on its model; the next run uses the new one", async () => {
      const target: { id?: string; changed: boolean } = { changed: false };
      const { queue, calls } = await start(async () => {
        if (target.changed || target.id === undefined) return;
        target.changed = true;
        await pool.query("update public.agents set model = 'claude-opus-5-5' where id = $1", [
          target.id,
        ]);
      });
      const agentId = await newAgent(WORKSPACE, "claude-sonnet-5-5");
      target.id = agentId;
      const first = await newRun(WORKSPACE, agentId);

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId: first });
      await waitFor(async () => (await runStatus(first)) === RUN_STATUS.succeeded);
      expect(calls).toEqual(Array<string>(3).fill("claude-sonnet-5-5"));

      const second = await newRun(WORKSPACE, agentId);
      await queue.enqueueRun({ workspaceId: WORKSPACE, runId: second });
      await waitFor(async () => (await runStatus(second)) === RUN_STATUS.succeeded);
      expect(calls.slice(3)).toEqual(Array<string>(3).fill("claude-opus-5-5"));
    });

    it("AC1: the job payload cannot name a model, and model output cannot change it", async () => {
      expect(
        runJobSchema.safeParse({
          workspace_id: WORKSPACE,
          run_id: randomUUID(),
          model: "claude-opus-5-5",
        }).success,
      ).toBe(false);

      // The script's text and tool input ask for other models on every step.
      const { queue, calls } = await start();
      const agentId = await newAgent(WORKSPACE, "claude-haiku-5-5");
      const runId = await newRun(WORKSPACE, agentId);
      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

      expect(calls).toEqual(Array<string>(3).fill("claude-haiku-5-5"));
    });

    it("AC2: an agent from another workspace is never resolved, and its run cannot be queued from this one", async () => {
      const { queue, calls } = await start();
      const foreignAgent = await newAgent(OTHER_WORKSPACE, "claude-opus-5-5");

      // The composite key refuses a run that mixes the workspace with a foreign agent.
      await expect(
        pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
          randomUUID(),
          WORKSPACE,
          foreignAgent,
        ]),
      ).rejects.toThrow();
      // The model reader scopes by workspace as well as by agent id.
      await expect(
        createPgAgentModelSource(pool).loadAgentModel({
          workspaceId: WORKSPACE,
          agentId: foreignAgent,
        }),
      ).resolves.toBeNull();

      const foreignRun = await newRun(OTHER_WORKSPACE, foreignAgent);
      await expect(
        queue.enqueueRun({ workspaceId: WORKSPACE, runId: foreignRun }),
      ).rejects.toBeInstanceOf(RunNotQueueableError);
      expect(calls).toEqual([]);
    });

    it.each(["", "gpt-9", "claude-sonnet-4", "CLAUDE-SONNET-5-5", "claude-sonnet-5-5 "])(
      "AC2: an agent whose stored model is %j fails at run start, with no retry, no fallback and no model call",
      async (stored) => {
        const { queue, calls, created } = await start();
        const agentId = await newAgent(WORKSPACE, stored);
        const runId = await newRun(WORKSPACE, agentId);

        await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
        await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.failed);
        // Give a retry the chance to appear; a non-retryable failure must not produce one.
        await sleep(2_500);

        expect(calls).toEqual([]);
        expect(created).toEqual([]);
        expect(await runStatus(runId)).toBe(RUN_STATUS.failed);
        expect((await jobRows(runId)).every((j) => j.retry_count === 0)).toBe(true);
        const rows = await events(runId);
        expect(rows.map((r) => r.type)).not.toContain("run.completed");
        expect(JSON.stringify(rows)).not.toContain("gpt-9");
      },
    );
  },
);
