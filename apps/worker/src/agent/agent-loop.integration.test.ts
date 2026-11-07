// AGO-167 integration test: the real queue (pg-boss), the real Postgres source and event store, the
// real context builder and the real loop, with a scripted fake model. No network, no API key.
// It skips itself when the shared local Supabase stack is down, so CI without Docker stays green.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-167 ... release AGO-167
import { randomUUID } from "node:crypto";

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
  type JobQueue,
} from "../queue/index.js";
import { createAgentLoop } from "./agent-loop.js";
import { createDenyByDefaultPolicyHook, type PolicyHook } from "./policy-hook.js";
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
const AGENT = randomUUID();
const ARCHIVED_AGENT = randomUUID();
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
  text: toolName === undefined ? "Integration result." : "",
  toolCalls: toolName === undefined ? [] : [{ id: "toolu_1", name: toolName, input: {} }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe.skipIf(!live)(
  "agent tool loop through the queue (live database)",
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

    const start = async (options: {
      script: (n: number, request: ModelRequest) => ModelResponse;
      tools?: readonly AgentTool[];
      policy?: PolicyHook;
      maxSteps?: number;
    }) => {
      const requests: ModelRequest[] = [];
      const provider: ModelProvider = {
        complete: (request) => {
          requests.push(request);
          return Promise.resolve(options.script(requests.length, request));
        },
      };
      const logger = createLogger({ level: "silent" });
      const executor = createAgentLoop({
        provider,
        contextBuilder: createContextBuilder({ source: createPgRunContextSource(pool), logger }),
        tools: createToolRegistry(options.tools ?? [getCurrentTimeTool]),
        policy: options.policy ?? createDenyByDefaultPolicyHook(),
        limits: { maxSteps: options.maxSteps ?? 25 },
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

    const newRun = async (agentId = AGENT): Promise<string> => {
      const id = randomUUID();
      await pool.query("insert into public.runs (id, workspace_id, agent_id) values ($1, $2, $3)", [
        id,
        WORKSPACE,
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

    const purgeJobs = () =>
      pool
        .query("delete from pgboss.job where name = any($1)", [[RUN_QUEUE, RUN_DEAD_LETTER_QUEUE]])
        .catch(() => undefined);

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await pool.query(
        "insert into public.workspaces (id, name) values ($1, 'AGO-167 loop test')",
        [WORKSPACE],
      );
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')",
        [AGENT, WORKSPACE],
      );
      await pool.query(
        "insert into public.agents (id, workspace_id, name, archived_at) values ($1, $2, 'retired', now())",
        [ARCHIVED_AGENT, WORKSPACE],
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
      delete from public.run_events where workspace_id = '${WORKSPACE}';
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id = '${WORKSPACE}';
      delete from public.agents where workspace_id = '${WORKSPACE}';
      delete from public.workspaces where id = '${WORKSPACE}';
      commit;`);
      await purgeJobs();
      await pool.end();
    });

    it("AC1: a run ends with a result, with every step and tool call recorded as events", async () => {
      const { queue, requests } = await start({
        script: (n) => (n === 1 ? reply("get_current_time") : reply()),
      });
      const runId = await newRun();

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

      const rows = await events(runId);
      expect(rows.map((row) => row.type)).toEqual([
        "run.created",
        "run.started",
        "step.started",
        "budget.usage",
        "tool_call.requested",
        "policy.decision",
        "tool_call.started",
        "tool_call.completed",
        "step.completed",
        "step.started",
        "budget.usage",
        "step.completed",
        "message.emitted",
        "run.completed",
      ]);
      expect(rows.at(-1)?.payload).toMatchObject({ steps: 2, summary: "Integration result." });
      expect(requests).toHaveLength(2);
    });

    it("AGO-145 carry-over: an oversized tool result is cut and the context.cut event lands in the live run_events table", async () => {
      const dump: AgentTool = {
        name: "dump",
        description: "returns a lot of text",
        tier: 0,
        inputSchema: z.looseObject({}),
        modelInputSchema: { type: "object" },
        execute: () => Promise.resolve("z".repeat(150_000)),
      };
      const { queue, requests } = await start({
        tools: [dump],
        policy: createDenyByDefaultPolicyHook(["dump"]),
        script: (n) => (n === 1 ? reply("dump") : reply()),
      });
      const runId = await newRun();

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

      const cut = (await events(runId)).find((row) => row.type === "context.cut");
      expect(cut?.payload).toMatchObject({
        section: "tool_result",
        action: "truncated",
        original_chars: 150_000,
        kept_chars: 20_000,
      });
      // The 150k-character result never reached the model whole.
      expect((requests[1]?.messages[0]?.content ?? "").length).toBeLessThan(48_000);
    });

    it("AC1: a run that hits the step limit ends with run.limit_reached and no result", async () => {
      const { queue, requests } = await start({
        script: () => reply("get_current_time"),
        maxSteps: 2,
      });
      const runId = await newRun();

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.failed);

      const types = (await events(runId)).map((row) => row.type);
      expect(types.at(-1)).toBe("run.limit_reached");
      expect(types).not.toContain("run.completed");
      expect(requests).toHaveLength(2);
    });

    it("AC2: a call the policy denies is never executed through the queue", async () => {
      const run = vi.fn(() => Promise.resolve("should not happen"));
      const dangerous: AgentTool = {
        name: "drop_tables",
        description: "dangerous",
        tier: 2,
        inputSchema: z.looseObject({}),
        modelInputSchema: { type: "object" },
        execute: run,
      };
      const { queue } = await start({
        tools: [dangerous],
        script: (n) => (n === 1 ? reply("drop_tables") : reply()),
      });
      const runId = await newRun();

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.succeeded);

      expect(run).not.toHaveBeenCalled();
      const decisions = (await events(runId)).filter((row) => row.type === "policy.decision");
      expect(decisions[0]?.payload).toMatchObject({
        decision: "deny",
        reason_code: "default_deny",
      });
    });

    it("AC2: needs_approval stops the run: approval.requested, run.paused, status paused, tool not run", async () => {
      const run = vi.fn(() => Promise.resolve("should not happen"));
      const sensitive: AgentTool = {
        name: "send_email",
        description: "sends email",
        tier: 2,
        inputSchema: z.looseObject({}),
        modelInputSchema: { type: "object" },
        execute: run,
      };
      const { queue, requests } = await start({
        tools: [sensitive],
        policy: {
          check: () =>
            Promise.resolve({ decision: "needs_approval", reasonCode: "human_required" }),
        },
        script: () => reply("send_email"),
      });
      const runId = await newRun();

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.paused);

      const rows = await events(runId);
      const approval = rows.find((row) => row.type === "approval.requested");
      expect(approval?.payload).toMatchObject({ call_id: "toolu_1", tier: 2 });
      expect(String((approval?.payload as { payload_hash?: string }).payload_hash)).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(rows.at(-1)?.type).toBe("run.paused");
      expect(run).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    });

    it("AGO-145 carry-over: a run for an archived agent is refused with run.failed, before any model call", async () => {
      const { queue, requests } = await start({ script: () => reply() });
      const runId = await newRun(ARCHIVED_AGENT);

      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => (await runStatus(runId)) === RUN_STATUS.failed);

      const failed = (await events(runId)).find((row) => row.type === "run.failed");
      expect(failed?.payload).toMatchObject({ reason: "agent_archived" });
      expect(requests).toHaveLength(0);
    });
  },
);
