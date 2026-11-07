// AGO-202 QA: two job queues with different names on the one shared local database stay isolated.
// Skips itself when the database is down. Run inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-202-qa ... release AGO-202-qa
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createLogger } from "../logger.js";
import type { ErrorTracker } from "../sentry.js";
import {
  createJobQueue,
  RUN_STATUS,
  runQueueNames,
  type JobQueue,
  type RunExecutionContext,
  type RunExecutor,
} from "./index.js";

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

const SUFFIX = randomUUID().slice(0, 8);
const NAME_A = `agent-run-qa202-a-${SUFFIX}`;
const NAME_B = `agent-run-qa202-b-${SUFFIX}`;
const WORKSPACE = randomUUID();
const AGENT = randomUUID();
const RETRY = {
  retryLimit: 1,
  retryDelaySeconds: 1,
  retryDelayMaxSeconds: 2,
  expireInSeconds: 60,
} as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("AGO-202 queue isolation (live database)", () => {
  let pool: pg.Pool;
  const started: JobQueue[] = [];
  const tracker: ErrorTracker = {
    isEnabled: true,
    captureException: () => "evt",
    addBreadcrumb: () => undefined,
    close: () => Promise.resolve(true),
  };

  const makeQueue = async (queueName: string, executor?: RunExecutor): Promise<JobQueue> => {
    const queue = createJobQueue({
      connectionString: DATABASE_URL,
      logger: createLogger({ level: "silent" }),
      errorTracker: tracker,
      executor,
      queueName,
      retryPolicy: RETRY,
      pollingIntervalSeconds: 0.5,
      shutdownTimeoutMs: 10_000,
      concurrency: 2,
    });
    started.push(queue);
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

  const jobCount = async (name: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>("select count(*) as n from pgboss.job where name = $1", [
          name,
        ])
      ).rows[0]?.n,
    );

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(
      "insert into public.workspaces (id, name) values ($1, 'AGO-202 QA isolation')",
      [WORKSPACE],
    );
    await pool.query(
      "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
      [AGENT, WORKSPACE],
    );
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((queue) => queue.stop()));
  });

  afterAll(async () => {
    await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id = '${WORKSPACE}';
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id = '${WORKSPACE}';
      delete from public.workspaces where id = '${WORKSPACE}';
      commit;`);
    for (const name of [NAME_A, NAME_B]) {
      const { queue, deadLetter } = runQueueNames(name);
      await pool
        .query("delete from pgboss.job where name = any($1)", [[queue, deadLetter]])
        .catch(() => undefined);
      for (const q of [queue, deadLetter]) {
        await pool.query("select pgboss.delete_queue($1)", [q]).catch(() => undefined);
      }
    }
    await pool.end();
  });

  it("AC2: a consumer on another queue never steals a job, and purging that queue leaves it intact", async () => {
    const executedByB: string[] = [];
    const executedByA: string[] = [];

    const enqueuerA = await makeQueue(NAME_A);
    const runId = await newRun();
    expect((await enqueuerA.enqueueRun({ workspaceId: WORKSPACE, runId })).enqueued).toBe(true);

    // A live consumer on queue B, on the same database, while A's job waits.
    await makeQueue(NAME_B, {
      execute: (ctx: RunExecutionContext) => {
        executedByB.push(ctx.runId);
        return Promise.resolve({ steps: 1 });
      },
    });
    // A suite that purges queue B (as the AGO-151 suites do before each test) must not touch A's job.
    await pool.query("delete from pgboss.job where name = any($1)", [
      [runQueueNames(NAME_B).queue, runQueueNames(NAME_B).deadLetter],
    ]);
    await sleep(2_000);
    expect(executedByB).toEqual([]);
    expect(await jobCount(NAME_A)).toBe(1);
    expect(await jobCount(NAME_B)).toBe(0);

    // Only a consumer on A runs it, exactly once.
    await makeQueue(NAME_A, {
      execute: (ctx: RunExecutionContext) => {
        executedByA.push(ctx.runId);
        return Promise.resolve({ steps: 1 });
      },
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await pool.query<{ status: string }>(
        "select status from public.runs where id = $1",
        [runId],
      );
      if (rows[0]?.status === RUN_STATUS.succeeded) break;
      if (Date.now() > deadline) throw new Error("run did not succeed on its own queue");
      await sleep(150);
    }
    expect(executedByA).toEqual([runId]);
    expect(executedByB).toEqual([]);
  });

  it("AC2: the production queue name and its dead letter are the defaults, a custom name never aliases them", () => {
    expect(runQueueNames()).toEqual({ queue: "agent-run", deadLetter: "agent-run-dead" });
    for (const name of [NAME_A, NAME_B]) {
      const { queue, deadLetter } = runQueueNames(name);
      expect(queue).not.toBe("agent-run");
      expect(deadLetter).not.toBe("agent-run-dead");
    }
  });
});
