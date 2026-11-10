// AGO-167 QA integration test: the real queue (pg-boss), Postgres, event store and context builder with
// a scripted fake model. No network, no API key. Skips itself when the local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-167-qa ... release AGO-167-qa
import { randomUUID } from "node:crypto";
import { offerAllTools } from "./tool-offer.test-helpers.js";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
import { createAgentLoop } from "./agent-loop.js";
import { createDenyByDefaultPolicyHook } from "./policy-hook.js";
import { createToolRegistry, getCurrentTimeTool, type AgentTool } from "./tools.js";

import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider.js";
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
const AGENT = randomUUID();
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

const reply = (toolName?: string): ModelResponse => ({
  text: toolName === undefined ? "QA result." : "",
  toolCalls: toolName === undefined ? [] : [{ id: "toolu_1", name: toolName, input: {} }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe.skipIf(!live)("AGO-167 QA through the queue (live database)", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  const queues: JobQueue[] = [];
  const tracker: ErrorTracker = {
    isEnabled: false,
    captureException: () => undefined,
    addBreadcrumb: () => undefined,
    close: () => Promise.resolve(true),
  };

  const start = async (options: {
    script: (n: number, request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
    tools?: readonly AgentTool[];
    maxWallMs?: number;
  }) => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      complete: async (request) => {
        requests.push(request);
        return options.script(requests.length, request);
      },
    };
    const logger = createLogger({ level: "silent" });
    const executor = createAgentLoop({
      toolOffer: offerAllTools,
      provider,
      contextBuilder: createContextBuilder({ source: createPgRunContextSource(pool), logger }),
      tools: createToolRegistry(options.tools ?? [getCurrentTimeTool]),
      policy: createDenyByDefaultPolicyHook(),
      ...(options.maxWallMs === undefined ? {} : { limits: { maxWallMs: options.maxWallMs } }),
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
    return { queue, requests };
  };

  const newRun = async (): Promise<string> => {
    const id = randomUUID();
    await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
      id,
      WORKSPACE,
      AGENT,
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

  const jobState = async (runId: string): Promise<string | undefined> =>
    (
      await pool.query<{ state: string }>(
        "select state from pgboss.job where name = $1 and data->>'run_id' = $2 order by created_on desc limit 1",
        [RUN_QUEUE, runId],
      )
    ).rows[0]?.state;

  const purgeJobs = () =>
    pool
      .query("delete from pgboss.job where name = any($1)", [[RUN_QUEUE, RUN_DEAD_LETTER_QUEUE]])
      .catch(() => undefined);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-167 QA a')", [
      WORKSPACE,
    ]);
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-167 QA b')", [
      OTHER_WORKSPACE,
    ]);
    await pool.query(
      "insert into public.agents (id, workspace_id, name) values ($1, $2, 'qa agent')",
      [AGENT, WORKSPACE],
    );
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

  it("AC1: a duplicate job for the same run produces one run (one model call, one result event)", async () => {
    const { queue, requests } = await start({ script: () => reply() });
    const runId = await newRun();

    const results = await Promise.all([
      queue.enqueueRun({ workspaceId: WORKSPACE, runId }),
      queue.enqueueRun({ workspaceId: WORKSPACE, runId }),
    ]);
    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

    expect(results.filter((r) => r.enqueued)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const types = (await events(runId)).map((row) => row.type);
    expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
    expect(types.filter((t) => t === "run.started")).toHaveLength(1);
  });

  it("AC1: a model call that never returns ends the run with run.limit_reached (time) through the real queue", async () => {
    const { queue } = await start({
      maxWallMs: 400,
      script: (_n, request) =>
        new Promise<ModelResponse>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const runId = await newRun();

    await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.failed);

    const rows = await events(runId);
    expect(rows.at(-1)?.type).toBe("run.limit_reached");
    expect(rows.at(-1)?.payload).toMatchObject({ limit: "time", max: 400 });
    expect(rows.map((r) => r.type)).not.toContain("run.completed");
  });

  it("AC2: a model that names an unregistered tool is denied and the tool set stays fixed, through the queue", async () => {
    const guarded = vi.fn(() => Promise.resolve("should not happen"));
    const tool: AgentTool = {
      name: "read_secrets",
      description: "reads secrets",
      tier: 1,
      inputSchema: z.looseObject({}),
      modelInputSchema: { type: "object" },
      execute: guarded,
    };
    const { queue, requests } = await start({
      tools: [tool],
      script: (n) => (n === 1 ? reply("Read_Secrets") : reply()),
    });
    const runId = await newRun();

    await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

    expect(guarded).not.toHaveBeenCalled();
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(["read_secrets"]);
    const decisions = (await events(runId)).filter((row) => row.type === "policy.decision");
    expect(decisions[0]?.payload).toMatchObject({ decision: "deny", reason_code: "unknown_tool" });
  });

  it("AC2: a job that names a run from another workspace is refused at enqueue, never reaches the model and leaves the run untouched", async () => {
    const { queue, requests } = await start({ script: () => reply() });
    const runId = await newRun(); // belongs to WORKSPACE

    await expect(queue.enqueueRun({ workspaceId: OTHER_WORKSPACE, runId })).rejects.toBeInstanceOf(
      RunNotQueueableError,
    );

    expect(await jobState(runId)).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(await runStatus(runId)).not.toBe(RUN_STATUS.succeeded);
    expect(await events(runId)).toEqual([]);
  });

  it("AC2: the events of a finished run are append-only (update and delete are refused)", async () => {
    const { queue } = await start({ script: () => reply() });
    const runId = await newRun();
    await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

    await expect(
      pool.query("update public.run_events set type = 'run.completed' where run_id = $1", [runId]),
    ).rejects.toThrow();
    await expect(
      pool.query("delete from public.run_events where run_id = $1", [runId]),
    ).rejects.toThrow();
    expect((await events(runId)).length).toBeGreaterThan(0);
  });
});
