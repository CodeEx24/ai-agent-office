// AGO-25 QA integration test (tester): the real queue (pg-boss), the real Postgres grants (AGO-141 `agent_capabilities`
// joined to the AGO-125 catalog), the real policy engine (AGO-34) and the real loop, with a scripted fake
// model. No network, no API key. It skips itself when the shared local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-25-qa ... release AGO-25-qa
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createContextBuilder, createPgRunContextSource } from "../context/index.js";
import { createPgCredentialStore } from "../identity/index.js";
import { createLogger } from "../logger.js";
import { createPgPolicySource, createPolicyEngineHook } from "../policy/index.js";
import {
  createJobQueue,
  RUN_DEAD_LETTER_QUEUE,
  RUN_QUEUE,
  RUN_STATUS,
  type JobQueue,
} from "../queue/index.js";
import { createAgentLoop, TOOL_NOT_OFFERED } from "./agent-loop.js";
import { createPgGrantedCapabilitySource, createToolOffer } from "./tool-offer.js";
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
const OTHER_AGENT = randomUUID();
const FAST_RETRY = {
  retryLimit: 0,
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

const usage = { inputTokens: 10, outputTokens: 5 };
const callOf = (id: string, ...names: string[]): ModelResponse => ({
  text: "",
  toolCalls: names.map((name, i) => ({ id: `${id}_${String(i)}`, name, input: {} })),
  usage,
});
const finalAnswer: ModelResponse = { text: "Integration result.", toolCalls: [], usage };

describe.skipIf(!live)(
  "AGO-25 QA: ungranted tools are filtered from the model (live database)",
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
    const ran = vi.fn<(name: string) => void>();

    const tool = (
      name: string,
      tier: 0 | 1 | 3,
      capabilityKey: string,
      onRun?: () => Promise<void>,
    ) =>
      ({
        name,
        description: `${name} tool`,
        tier,
        capabilityKey,
        inputSchema: z.looseObject({}),
        modelInputSchema: { type: "object" },
        execute: async () => {
          ran(name);
          await onRun?.();
          return "ok";
        },
      }) satisfies AgentTool;

    const start = async (options: {
      script: (n: number, request: ModelRequest) => ModelResponse;
      tools: readonly AgentTool[];
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
        tools: createToolRegistry([getCurrentTimeTool, ...options.tools]),
        toolOffer: createToolOffer({
          source: createPgGrantedCapabilitySource(createPgCredentialStore(pool)),
        }),
        policy: createPolicyEngineHook({ source: createPgPolicySource(pool) }),
      });
      const queue = createJobQueue({
        connectionString: DATABASE_URL,
        logger,
        errorTracker: tracker,
        executor,
        retryPolicy: FAST_RETRY,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 10_000,
        concurrency: 1,
      });
      queues.push(queue);
      await queue.start();
      return { queue, requests };
    };

    const newRun = async (agentId: string, workspaceId = WORKSPACE): Promise<string> => {
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

    const grant = (workspaceId: string, agentId: string, capability: string, tier: number) =>
      pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
         values ($1, $2, $3, $4, 'automatic')`,
        [workspaceId, agentId, capability, tier],
      );

    const purgeJobs = () =>
      pool
        .query("delete from pgboss.job where name = any($1)", [[RUN_QUEUE, RUN_DEAD_LETTER_QUEUE]])
        .catch(() => undefined);

    const toolNames = (request: ModelRequest | undefined) =>
      request?.tools.map((t) => t.name).sort();

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      // Workspace creation seeds the capability catalog (AGO-125).
      for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
        await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-25 QA test')", [
          id,
        ]);
      }
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'a')", [
        AGENT,
        WORKSPACE,
      ]);
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'b')", [
        OTHER_AGENT,
        OTHER_WORKSPACE,
      ]);
    });

    beforeEach(async () => {
      ran.mockClear();
      await purgeJobs();
      await pool.query("delete from public.agent_capabilities where workspace_id = any($1)", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);
      await pool.query(
        "update public.capabilities set enabled = true where workspace_id = any($1)",
        [[WORKSPACE, OTHER_WORKSPACE]],
      );
    });

    afterEach(async () => {
      await Promise.all(queues.splice(0).map((queue) => queue.stop()));
    });

    afterAll(async () => {
      // run_events is append-only: clean up the way scripts/run-events-teardown.mjs does.
      const ids = `'${WORKSPACE}', '${OTHER_WORKSPACE}'`;
      await pool.query(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.runs where workspace_id in (${ids});
      delete from public.agent_capabilities where workspace_id in (${ids});
      delete from public.agents where workspace_id in (${ids});
      delete from public.workspaces where id in (${ids});
      commit;`);
      await purgeJobs();
      await pool.end();
    });

    const SECRET = ["sk", "ant", "api03", "QA-LIVE-0123456789abcdef"].join("-");

    const runToEnd = async (options: Parameters<typeof start>[0], agentId = AGENT) => {
      const { queue, requests } = await start(options);
      const runId = await newRun(agentId);
      await queue.enqueueRun({ workspaceId: WORKSPACE, runId });
      await waitFor(async () => {
        const status = await runStatus(runId);
        return status !== "queued" && status !== "running" && status;
      });
      return { runId, requests, status: await runStatus(runId) };
    };

    it("AC1: with no grants the agent is offered only the built-in tool", async () => {
      const { requests, status } = await runToEnd({
        tools: [tool("read_note", 0, "vault.read")],
        script: () => finalAnswer,
      });
      expect(status).toBe(RUN_STATUS.succeeded);
      expect(toolNames(requests[0])).toEqual(["get_current_time"]);
    });

    it("AC1: a grant added mid-run appears on the next model call, and a catalog disable removes it again", async () => {
      const addSearchGrant = async () => {
        await grant(WORKSPACE, AGENT, "web.search", 1);
      };
      const disableSearchInCatalog = async () => {
        await pool.query(
          "update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'",
          [WORKSPACE],
        );
      };
      await grant(WORKSPACE, AGENT, "vault.read", 0);
      const { requests, status } = await runToEnd({
        tools: [
          tool("read_note", 0, "vault.read", addSearchGrant),
          tool("search_web", 1, "web.search", disableSearchInCatalog),
        ],
        script: (n) => {
          if (n === 1) return callOf("toolu_a", "read_note");
          if (n === 2) return callOf("toolu_b", "search_web");
          return finalAnswer;
        },
      });
      expect(status).toBe(RUN_STATUS.succeeded);
      expect(toolNames(requests[0])).toEqual(["get_current_time", "read_note"]);
      expect(toolNames(requests[1])).toEqual(["get_current_time", "read_note", "search_web"]);
      expect(toolNames(requests[2])).toEqual(["get_current_time", "read_note"]);
      expect(ran.mock.calls).toEqual([["read_note"], ["search_web"]]);
    });

    it("AC1: another workspace's grant of the same capability is never offered here (cross-workspace)", async () => {
      await grant(OTHER_WORKSPACE, OTHER_AGENT, "vault.read", 0);
      const { requests } = await runToEnd({
        tools: [tool("read_note", 0, "vault.read")],
        script: (n) => (n === 1 ? callOf("toolu_x", "read_note") : finalAnswer),
      });
      expect(toolNames(requests[0])).toEqual(["get_current_time"]);
      expect(ran).not.toHaveBeenCalled();
    });

    it("AC2: unlisted, renamed and unknown names are denied and logged with no argument in run_events", async () => {
      await grant(WORKSPACE, AGENT, "vault.read", 0);
      const { runId, status } = await runToEnd({
        tools: [tool("read_note", 0, "vault.read"), tool("send_email", 1, "email.send")],
        script: (n) =>
          n === 1
            ? {
                text: "",
                toolCalls: ["send_email", "READ_NOTE", "no_such_tool", "read_note "].map(
                  (name, i) => ({ id: `toolu_${String(i)}`, name, input: { token: SECRET } }),
                ),
                usage,
              }
            : finalAnswer,
      });
      expect(status).toBe(RUN_STATUS.succeeded);
      expect(ran).not.toHaveBeenCalled();
      const rows = await events(runId);
      const decisions = rows.filter((row) => row.type === "policy.decision");
      expect(decisions.map((row) => [row.payload.decision, row.payload.reason_code])).toEqual(
        Array.from({ length: 4 }, () => ["deny", TOOL_NOT_OFFERED]),
      );
      expect(rows.some((row) => row.type === "approval.requested")).toBe(false);
      expect(rows.some((row) => row.type === "tool_call.started")).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    });

    it("AC3: a granted tier 3 tool is offered but still stops for a human and does not run", async () => {
      await pool.query(
        `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
         values ($1, $2, 'code.run', 3, 'approval')`,
        [WORKSPACE, AGENT],
      );
      const { runId, requests } = await runToEnd({
        tools: [tool("run_code", 3, "code.run")],
        script: (n) => (n === 1 ? callOf("toolu_t3", "run_code") : finalAnswer),
      });
      expect(toolNames(requests[0])).toEqual(["get_current_time", "run_code"]);
      expect(ran).not.toHaveBeenCalled();
      const rows = await events(runId);
      expect(rows.some((row) => row.type === "approval.requested")).toBe(true);
      expect(rows.some((row) => row.type === "tool_call.started")).toBe(false);
    });
  },
);
