// AGO-151 integration tests against the shared local Supabase stack (127.0.0.1:44322).
// They skip themselves when the database is down, so CI without Docker stays green. Run them inside
// the db lock:  node scripts/db-lock.mjs acquire AGO-151 ... release AGO-151
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createLogger } from "../logger.js";
import {
  createJobQueue,
  RUN_STATUS,
  runQueueNames,
  type JobQueue,
  type RunExecutionContext,
  type RunExecutor,
} from "./index.js";

import { hardenPgbossFunctions } from "./pgboss-hardening.js";
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

// Its own queue (not the shared `agent-run`): another suite or worktree using this database can neither
// consume these jobs nor have its own purged by this file (AGO-202).
const QUEUE_NAME = `agent-run-test-${randomUUID().slice(0, 8)}`;
const QUEUES = runQueueNames(QUEUE_NAME);
const WORKSPACE = randomUUID();
const AGENT = randomUUID();
const FAST_RETRY = {
  retryLimit: 2,
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

describe.skipIf(!live)("job queue (live database)", () => {
  let pool: pg.Pool;
  const queues: JobQueue[] = [];
  const captured: { error: unknown; context: unknown }[] = [];
  const tracker: ErrorTracker = {
    isEnabled: true,
    captureException: (error, context) => {
      captured.push({ error, context });
      return "evt";
    },
    addBreadcrumb: () => undefined,
    close: () => Promise.resolve(true),
  };

  const makeQueue = async (executor?: RunExecutor): Promise<JobQueue> => {
    const queue = createJobQueue({
      connectionString: DATABASE_URL,
      logger: createLogger({ level: "silent" }),
      errorTracker: tracker,
      executor,
      queueName: QUEUE_NAME,
      retryPolicy: FAST_RETRY,
      pollingIntervalSeconds: 0.5,
      shutdownTimeoutMs: 10_000,
      concurrency: 4,
    });
    queues.push(queue);
    await queue.start();
    return queue;
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

  const eventTypes = async (runId: string): Promise<string[]> =>
    (
      await pool.query<{ type: string }>(
        "select type from public.run_events where run_id = $1 order by seq",
        [runId],
      )
    ).rows.map((row) => row.type);

  const purgeJobs = () =>
    pool
      .query("delete from pgboss.job where name = any($1)", [[QUEUES.queue, QUEUES.deadLetter]])
      .catch(() => undefined);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-151 queue test')", [
      WORKSPACE,
    ]);
    await pool.query(
      "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
      [AGENT, WORKSPACE],
    );
  });

  beforeEach(async () => {
    captured.length = 0;
    // Another test's leftovers must not be picked up by this one.
    await purgeJobs();
  });

  afterEach(async () => {
    // A queue left running would keep consuming jobs of the next test (one shared pgboss queue).
    await Promise.all(queues.splice(0).map((queue) => queue.stop()));
  });

  afterAll(async () => {
    // run_events is append-only and its parents are RESTRICT, so a test cleans up the way
    // scripts/run-events-teardown.mjs does: guard off, delete, guard back on, in one transaction.
    await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id = '${WORKSPACE}';
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id = '${WORKSPACE}';
      delete from public.workspaces where id = '${WORKSPACE}';
      commit;`);
    await purgeJobs();
    // Unique queue names must not pile up in pgboss.queue run after run.
    for (const name of [QUEUES.queue, QUEUES.deadLetter]) {
      await pool.query("select pgboss.delete_queue($1)", [name]).catch(() => undefined);
    }
    await pool.end();
  });

  it("AC1: a duplicate or concurrent enqueue of one run executes it exactly once", async () => {
    const executions: string[] = [];
    const queue = await makeQueue({
      execute: async (ctx: RunExecutionContext) => {
        executions.push(ctx.runId);
        await sleep(300);
        return { steps: 1 };
      },
    });
    const runId = await newRun();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => queue.enqueueRun({ workspaceId: WORKSPACE, runId })),
    );
    expect(results.filter((r) => r.enqueued)).toHaveLength(1);

    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);
    await sleep(1_500); // time for any stray second job to show up
    expect(executions).toEqual([runId]);
    expect(await eventTypes(runId)).toEqual(["run.created", "run.started", "run.completed"]);
  });

  it("AC1: different idempotency keys for one run cannot double-execute (database guard)", async () => {
    const executions: string[] = [];
    const queue = await makeQueue({
      execute: async (ctx) => {
        executions.push(ctx.runId);
        await sleep(300);
        return { steps: 1 };
      },
    });
    const runId = await newRun();

    // Different keys get past pg-boss's dedupe, so only the conditional claim stands in the way.
    const results = await Promise.all(
      ["key-a", "key-b", "key-c", "key-d"].map((idempotencyKey) =>
        queue.enqueueRun({ workspaceId: WORKSPACE, runId, idempotencyKey }),
      ),
    );
    expect(results.every((r) => r.enqueued)).toBe(true);

    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);
    await sleep(1_500);
    expect(executions).toEqual([runId]);
    expect((await eventTypes(runId)).filter((type) => type === "run.started")).toHaveLength(1);
  });

  it("AC2: a failing job retries with backoff up to the limit, then lands in the visible dead-letter queue", async () => {
    const attempts: { attempt: number; at: number }[] = [];
    const queue = await makeQueue({
      execute: (ctx) => {
        attempts.push({ attempt: ctx.attempt, at: Date.now() });
        return Promise.reject(new Error("tool exploded"));
      },
    });
    const runId = await newRun();
    await queue.enqueueRun({ workspaceId: WORKSPACE, runId });

    await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.failed, 40_000);

    // retryLimit 2 => the first attempt plus exactly two retries, never more.
    expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
    const gaps = attempts.slice(1).map((a, i) => a.at - (attempts[i]?.at ?? 0));
    expect(gaps.every((gap) => gap >= 900)).toBe(true); // the backoff delay applies between attempts

    const report = await waitFor(async () => {
      const current = await queue.health();
      return current.depth?.dead_letter === 1 ? current : undefined;
    });
    expect(report.depth).toMatchObject({ queued: 0, active: 0, dead_letter: 1 });

    expect(await eventTypes(runId)).toEqual([
      "run.created",
      "run.started",
      "run.started",
      "run.started",
      "run.failed",
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.context).toMatchObject({ run_id: runId, workspace_id: WORKSPACE });
  }, 60_000);

  it("AC3: health reports ok with the queue depth", async () => {
    const queue = await makeQueue(); // no executor: jobs stay queued
    await queue.enqueueRun({ workspaceId: WORKSPACE, runId: await newRun() });
    await queue.enqueueRun({ workspaceId: WORKSPACE, runId: await newRun() });

    expect(await queue.health()).toEqual({
      status: "ok",
      depth: { queued: 2, active: 0, failed: 0, dead_letter: 0 },
    });
  });

  it("shutdown drains: stop() waits for the running job to finish and the run completes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const queue = await makeQueue({
      execute: async () => {
        started = true;
        await gate;
        return { steps: 1 };
      },
    });
    const runId = await newRun();
    await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
    await waitFor(() => Promise.resolve(started));

    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });
    await sleep(1_200);
    expect(stopped).toBe(false); // still draining
    expect(await runStatus(runId)).toBe(RUN_STATUS.running);

    release();
    await stopping;
    expect(await runStatus(runId)).toBe(RUN_STATUS.succeeded);
  });

  it("refuses to enqueue a run from another workspace or one that is not queued", async () => {
    const queue = await makeQueue();
    const runId = await newRun();
    await expect(queue.enqueueRun({ workspaceId: randomUUID(), runId })).rejects.toThrow(
      "not found or not queued",
    );
    await pool.query("update public.runs set status = 'succeeded' where id = $1", [runId]);
    await expect(queue.enqueueRun({ workspaceId: WORKSPACE, runId })).rejects.toThrow(
      "not found or not queued",
    );
  });

  it("keeps the pgboss schema away from the web roles", async () => {
    await makeQueue();
    const leaked = await pool.query<{ leaked: number }>(
      `select count(*)::int as leaked
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'pgboss' and c.relkind in ('r', 'p', 'v')
          and (has_table_privilege('anon', c.oid, 'SELECT')
            or has_table_privilege('authenticated', c.oid, 'SELECT'))`,
    );
    expect(leaked.rows[0]?.leaked).toBe(0);
    const usage = await pool.query<{ anon: boolean; authenticated: boolean }>(
      `select has_schema_privilege('anon', 'pgboss', 'USAGE') as anon,
              has_schema_privilege('authenticated', 'pgboss', 'USAGE') as authenticated`,
    );
    expect(usage.rows[0]).toEqual({ anon: false, authenticated: false });
  });

  it("hardening survives many concurrent starts and leaves no API role with EXECUTE", async () => {
    await makeQueue(); // installs the pgboss schema and its functions
    const grantsLeft = async (): Promise<number> => {
      const { rows } = await pool.query<{ held: number }>(
        `select count(*)::int as held
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'pgboss'
            and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('service_role', p.oid, 'EXECUTE')
              or has_function_privilege('public', p.oid, 'EXECUTE'))`,
      );
      return rows[0]?.held ?? -1;
    };
    // Reproduce the pg-boss install/upgrade default so there is real work to serialise.
    await pool.query("grant execute on all functions in schema pgboss to public");
    expect(await grantsLeft()).toBeGreaterThan(0);

    const WORKERS = 12;
    const pools = Array.from(
      { length: WORKERS },
      () => new pg.Pool({ connectionString: DATABASE_URL, max: 1 }),
    );
    try {
      const results = await Promise.allSettled(pools.map((p) => hardenPgbossFunctions(p)));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    } finally {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    }
    expect(await grantsLeft()).toBe(0);
    // Idempotent: a second round finds nothing to revoke and still succeeds.
    await hardenPgbossFunctions(pool);
    expect(await grantsLeft()).toBe(0);
  });
});
