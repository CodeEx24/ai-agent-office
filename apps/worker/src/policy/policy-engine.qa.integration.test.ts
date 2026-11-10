// AGO-34 QA integration test, written by the tester. Real Postgres (policies, grants, catalog) feeding the
// real policy engine hook inside the real agent loop, with a scripted fake model. No network, no API key.
// Skips itself when the local Supabase stack is down.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-34-qa ... release AGO-34-qa
import { createHash, randomUUID } from "node:crypto";
import { offerAllTools } from "../agent/tool-offer.test-helpers.js";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentLoop } from "../agent/agent-loop.js";
import { createToolRegistry, getCurrentTimeTool, type AgentTool } from "../agent/tools.js";
import { LOCAL_DATABASE_URL } from "../config.js";
import { createContextBuilder } from "../context/index.js";
import { createRunEventEmitter, type RunEventRow } from "../events/index.js";
import { createLogger } from "../logger.js";

import { createPgPolicySource, type PolicySource } from "./pg-policy-source.js";
import { createPolicyEngineHook } from "./policy-engine-hook.js";

import type { ModelProvider, ModelResponse } from "../agent/model-provider.js";
import type { RunExecutionContext } from "../queue/run-processor.js";
import type { CapabilityTier } from "@ago/shared";

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
const USER = randomUUID();
const MEMBER = randomUUID();
const OTHER_USER = randomUUID();
const OTHER_MEMBER = randomUUID();
const AGENT = randomUUID();
const OTHER_WS_AGENT = randomUUID();
const DEPARTMENT = randomUUID();
const RUN = randomUUID();
const SECRET = "sk-ant-api03-QA-SECRET-0123456789abcdef";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function fakeTool(
  name: string,
  capabilityKey: string | undefined,
  tier: CapabilityTier,
): AgentTool & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => Promise.resolve("executed"));
  return {
    name,
    description: `${name} tool`,
    tier,
    ...(capabilityKey === undefined ? {} : { capabilityKey }),
    inputSchema: z.looseObject({}),
    modelInputSchema: { type: "object" },
    execute: run,
    run,
  };
}

/** A scripted model: the first reply calls `name`, the second is the final answer. */
const callOnce = (name: string, input: unknown): ModelProvider => {
  let n = 0;
  return {
    complete: (): Promise<ModelResponse> => {
      n += 1;
      return Promise.resolve({
        text: n === 1 ? "" : "done",
        toolCalls: n === 1 ? [{ id: "toolu_1", name, input }] : [],
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
};

describe.skipIf(!live)(
  "AGO-34 QA: policy engine against the database and the loop",
  { timeout: 30_000 },
  () => {
    let pool: pg.Pool;
    const source = (): PolicySource => createPgPolicySource(pool);

    const setPolicy = (workspace: string, level: string, scopeId: string | null, rule: unknown) => {
      const author = workspace === OTHER_WORKSPACE ? OTHER_MEMBER : MEMBER;
      return pool.query(
        `insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
         values ($1, $2, $3, $4::jsonb, $5, $5)`,
        [workspace, level, scopeId, JSON.stringify(rule), author],
      );
    };
    const clearPolicies = () =>
      pool.query("delete from public.policies where workspace_id = any($1)", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);

    /** Runs the real loop for one scripted tool call, with the real database policy source. */
    async function runLoop(options: {
      tool: AgentTool;
      input?: unknown;
      policySource?: PolicySource;
      policyTimeoutMs?: number;
    }) {
      const rows: RunEventRow[] = [];
      const logger = createLogger({ level: "silent" });
      const emitter = createRunEventEmitter({
        workspaceId: WORKSPACE,
        runId: RUN,
        logger,
        store: {
          insert: (row) => {
            rows.push(row);
            return Promise.resolve({
              id: String(rows.length),
              seq: rows.length,
              created_at: "now",
            });
          },
        },
      });
      const loop = createAgentLoop({
        toolOffer: offerAllTools,
        provider: callOnce(options.tool.name, options.input ?? {}),
        contextBuilder: createContextBuilder({
          source: {
            loadRun: () =>
              Promise.resolve({
                runId: RUN,
                workspaceId: WORKSPACE,
                agent: {
                  id: AGENT,
                  workspaceId: WORKSPACE,
                  name: "QA",
                  role: "Tests.",
                  prompt: null,
                },
                task: { id: randomUUID(), workspaceId: WORKSPACE, title: "t", description: "d" },
              }),
            loadAssignedSkills: () => Promise.resolve([]),
          },
          logger,
        }),
        tools: createToolRegistry([getCurrentTimeTool, options.tool]),
        policy: createPolicyEngineHook({ source: options.policySource ?? source() }),
        ...(options.policyTimeoutMs === undefined
          ? {}
          : { policyTimeoutMs: options.policyTimeoutMs }),
      });
      const ctx: RunExecutionContext = {
        workspaceId: WORKSPACE,
        runId: RUN,
        agentId: AGENT,
        taskId: null,
        attempt: 0,
        logger,
        emitter,
        signal: new AbortController().signal,
      };
      const outcome = await loop.execute(ctx);
      const payloads = (type: string) =>
        rows.filter((row) => row.type === type).map((row) => row.payload);
      return { outcome, rows, payloads };
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
      // Workspace creation seeds the capability catalog (AGO-125).
      for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
        await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-34 QA')", [id]);
      }
      await pool.query("insert into auth.users (id) values ($1), ($2)", [USER, OTHER_USER]);
      await pool.query(
        "insert into public.members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')",
        [MEMBER, WORKSPACE, USER, OTHER_MEMBER, OTHER_WORKSPACE, OTHER_USER],
      );
      await pool.query(
        "insert into public.agents (id, workspace_id, name, department_id) values ($1, $2, 'qa', $3)",
        [AGENT, WORKSPACE, DEPARTMENT],
      );
      await pool.query(
        "insert into public.agents (id, workspace_id, name) values ($1, $2, 'other-ws')",
        [OTHER_WS_AGENT, OTHER_WORKSPACE],
      );
      for (const [key, tier, mode] of [
        ["vault.read", 0, "automatic"],
        ["web.search", 1, "automatic"],
        ["code.run", 3, "approval"],
        ["message.send_outbound", 4, "approval"],
      ] as const) {
        await pool.query(
          `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
           values ($1, $2, $3, $4, $5)`,
          [WORKSPACE, AGENT, key, tier, mode],
        );
      }
    });

    afterAll(async () => {
      await clearPolicies();
      await pool.query("delete from public.agents where workspace_id = any($1)", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);
      await pool.query("delete from public.members where workspace_id = any($1)", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);
      await pool.query("delete from public.workspaces where id = any($1)", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);
      await pool.query("delete from auth.users where id = any($1)", [[USER, OTHER_USER]]);
      await pool.end();
    });

    it("AC1: a tier 3 call escalates through the loop: approval.requested with a payload hash, tool never runs", async () => {
      await clearPolicies();
      const tool = fakeTool("run_code", "code.run", 3);
      const input = { code: "print(1)", token: SECRET };
      const { outcome, payloads } = await runLoop({ tool, input });

      expect(tool.run).not.toHaveBeenCalled();
      expect(outcome.end).toBe("paused");
      expect(payloads("policy.decision")).toEqual([
        expect.objectContaining({
          decision: "needs_approval",
          reason_code: "tier_requires_approval",
        }),
      ]);
      const [approval] = payloads("approval.requested");
      // sha256 of the sorted-key canonical JSON of { tool_name, input }
      const canonical = `{"input":{"code":"print(1)","token":"${SECRET}"},"tool_name":"run_code"}`;
      expect(approval).toMatchObject({ tier: 3, payload_hash: sha256(canonical) });
      expect(JSON.stringify(approval)).not.toContain(SECRET);
    });

    it("AC1: a tier 4 call escalates and never allows, even with an agent allow rule", async () => {
      await clearPolicies();
      await setPolicy(WORKSPACE, "agent", AGENT, {
        version: 1,
        rules: [{ action: "*", effect: "allow" }],
      });
      const tool = fakeTool("send_message", "message.send_outbound", 4);
      const { outcome, payloads } = await runLoop({ tool });
      expect(tool.run).not.toHaveBeenCalled();
      expect(outcome.end).toBe("paused");
      expect(payloads("policy.decision")[0]).toMatchObject({ decision: "needs_approval", tier: 4 });
      expect(payloads("approval.requested")).toHaveLength(1);
    });

    it("AC1: a tier 1 granted tool runs, so the escalate above comes from the tier and not a blanket block", async () => {
      await clearPolicies();
      const tool = fakeTool("search_web", "web.search", 1);
      const { outcome, payloads } = await runLoop({ tool });
      expect(tool.run).toHaveBeenCalledTimes(1);
      expect(outcome.end).toBe("completed");
      expect(payloads("policy.decision")[0]).toMatchObject({ decision: "allow" });
    });

    it.each([
      ["baseline", null],
      ["department", DEPARTMENT],
      ["agent", AGENT],
    ] as const)(
      "AC2: a %s deny stored in the database denies the call end to end",
      async (level, scope) => {
        await clearPolicies();
        await setPolicy(WORKSPACE, level, scope, {
          version: 1,
          rules: [{ action: "web.search", effect: "deny" }],
        });
        const tool = fakeTool("search_web", "web.search", 1);
        const { payloads } = await runLoop({ tool });
        expect(tool.run).not.toHaveBeenCalled();
        expect(payloads("policy.decision")[0]).toMatchObject({
          decision: "deny",
          reason_code: "deny_rule",
        });
        expect(payloads("approval.requested")).toHaveLength(0);
      },
    );

    it("AC2: a baseline deny is not loosened by an agent allow, and a deny on a tier 4 call is a deny, not an escalate", async () => {
      await clearPolicies();
      await setPolicy(WORKSPACE, "baseline", null, {
        version: 1,
        rules: [{ action: "message.*", effect: "deny" }],
      });
      await setPolicy(WORKSPACE, "agent", AGENT, {
        version: 1,
        rules: [{ action: "message.*", effect: "allow" }],
      });
      const tool = fakeTool("send_message", "message.send_outbound", 4);
      const { payloads } = await runLoop({ tool });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({ decision: "deny" });
      expect(payloads("approval.requested")).toHaveLength(0);
    });

    it("AC3: editing a policy row in place changes the very next decision", async () => {
      await clearPolicies();
      await setPolicy(WORKSPACE, "baseline", null, {
        version: 1,
        rules: [{ action: "web.search", effect: "deny" }],
      });
      const tool = fakeTool("search_web", "web.search", 1);
      expect((await runLoop({ tool })).payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
      });

      const edit = (rules: unknown) =>
        pool.query(
          "update public.policies set rule = $2::jsonb, updated_by = $3 where workspace_id = $1 and level = 'baseline'",
          [WORKSPACE, JSON.stringify({ version: 1, rules }), MEMBER],
        );
      await edit([{ action: "web.search", effect: "require_approval" }]);
      expect((await runLoop({ tool })).payloads("policy.decision")[0]).toMatchObject({
        decision: "needs_approval",
        reason_code: "rule_requires_approval",
      });
      await edit([]);
      expect((await runLoop({ tool })).payloads("policy.decision")[0]).toMatchObject({
        decision: "allow",
      });
      expect(tool.run).toHaveBeenCalledTimes(1);
    });

    it("AC3: the engine path reads the policies table and never the filesystem or the vault", () => {
      const files = [
        "src/policy/pg-policy-source.ts",
        "src/policy/policy-engine-hook.ts",
        "../../packages/shared/src/policy/policy-engine.ts",
      ].map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
      for (const text of files) {
        expect(text).not.toMatch(/from "node:(fs|path)|require\("fs"\)|vault-template|readFile/);
      }
      expect(files[0]).toMatch(/public\.policies/);
    });

    it("an ungranted capability is denied end to end and its tool never runs", async () => {
      await clearPolicies();
      const tool = fakeTool("browse", "browser.navigate", 1);
      const { payloads } = await runLoop({ tool });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: "not_granted",
      });
    });

    it("a tool with no capability key is denied (only the built-in clock is exempt)", async () => {
      await clearPolicies();
      const tool = fakeTool("sneaky", undefined, 0);
      const { payloads } = await runLoop({ tool });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: "no_capability",
      });
    });

    it("a disabled catalog capability is denied even though the agent holds the grant", async () => {
      await clearPolicies();
      await pool.query(
        "update public.capabilities set enabled = false where workspace_id = $1 and key = 'web.search'",
        [WORKSPACE],
      );
      try {
        const tool = fakeTool("search_web", "web.search", 1);
        const { payloads } = await runLoop({ tool });
        expect(tool.run).not.toHaveBeenCalled();
        expect(payloads("policy.decision")[0]).toMatchObject({ reason_code: "not_granted" });
      } finally {
        await pool.query(
          "update public.capabilities set enabled = true where workspace_id = $1 and key = 'web.search'",
          [WORKSPACE],
        );
      }
    });

    it.each([
      [
        "an unknown field on a rule",
        { version: 1, rules: [{ action: "x", effect: "deny", z: 1 }] },
      ],
      ["a bad effect", { version: 1, rules: [{ action: "x", effect: "maybe" }] }],
      ["an unknown top-level key", { version: 1, rules: [], allow_all: true }],
      ["a wrong version", { version: 2, rules: [] }],
    ])("a malformed policy row (%s) denies, never allows", async (_label, rule) => {
      await clearPolicies();
      await setPolicy(WORKSPACE, "baseline", null, rule);
      const tool = fakeTool("search_web", "web.search", 1);
      const { payloads } = await runLoop({ tool });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: "policy_invalid",
      });
    });

    it.each([
      ["a string", "allow everything"],
      ["an array", []],
      ["a JSON null", null],
    ])(
      "the database refuses a policy row that is %s instead of an object",
      async (_label, rule) => {
        await clearPolicies();
        await expect(setPolicy(WORKSPACE, "baseline", null, rule)).rejects.toThrow(
          /policies_rule_check/,
        );
      },
    );

    it.each([
      ["a string", "allow everything"],
      ["an array", []],
      ["a JSON null", null],
      ["a number", 7],
    ])(
      "the loader fails closed if a row that is %s ever reaches it (the engine denies)",
      async (_label, rule) => {
        const stubbed = {
          query: (sql: string, params?: unknown[]) => {
            if (sql.includes("public.policies")) {
              return Promise.resolve({ rows: [{ id: "p1", level: "baseline", rule }] });
            }
            return pool.query(sql, params);
          },
        };
        const tool = fakeTool("search_web", "web.search", 1);
        const { payloads } = await runLoop({
          tool,
          policySource: createPgPolicySource(stubbed as unknown as pg.Pool),
        });
        expect(tool.run).not.toHaveBeenCalled();
        expect(payloads("policy.decision")[0]).toMatchObject({
          decision: "deny",
          reason_code: "policy_invalid",
        });
      },
    );

    it("a policy load failure is a deny (policy_hook_error) and the tool never runs", async () => {
      const tool = fakeTool("search_web", "web.search", 1);
      const failing: PolicySource = { load: () => Promise.reject(new Error("connection refused")) };
      const { payloads } = await runLoop({ tool, policySource: failing });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: "policy_hook_error",
      });
    });

    it("a policy load that never answers is a deny (policy_timeout): timeout means deny", async () => {
      const tool = fakeTool("search_web", "web.search", 1);
      const hanging: PolicySource = { load: () => new Promise(() => undefined) };
      const { payloads } = await runLoop({ tool, policySource: hanging, policyTimeoutMs: 100 });
      expect(tool.run).not.toHaveBeenCalled();
      expect(payloads("policy.decision")[0]).toMatchObject({
        decision: "deny",
        reason_code: "policy_timeout",
      });
    });

    it("another workspace's policies never apply, and an agent id from another workspace is not found", async () => {
      await clearPolicies();
      await setPolicy(OTHER_WORKSPACE, "baseline", null, {
        version: 1,
        rules: [{ action: "*", effect: "deny" }],
      });
      await setPolicy(OTHER_WORKSPACE, "agent", OTHER_WS_AGENT, {
        version: 1,
        rules: [{ action: "*", effect: "deny" }],
      });
      const tool = fakeTool("search_web", "web.search", 1);
      const { payloads } = await runLoop({ tool });
      expect(tool.run).toHaveBeenCalledTimes(1);
      expect(payloads("policy.decision")[0]).toMatchObject({ decision: "allow" });

      // Cross-workspace probe: this agent id under the other workspace is rejected, not evaluated.
      await expect(
        createPgPolicySource(pool).load({ workspaceId: OTHER_WORKSPACE, agentId: AGENT }),
      ).rejects.toThrow(/agent not found/);
    });

    it("policy.decision and approval events carry no tool arguments and no secrets", async () => {
      await clearPolicies();
      await setPolicy(WORKSPACE, "baseline", null, {
        version: 1,
        rules: [{ action: "code.run", effect: "deny", note: `leak ${SECRET}` }],
      });
      const tool = fakeTool("run_code", "code.run", 3);
      const { rows } = await runLoop({ tool, input: { code: "rm -rf /", token: SECRET } });
      const text = JSON.stringify(rows.map((row) => row.payload));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("rm -rf");
      const [decision] = rows.filter((row) => row.type === "policy.decision");
      expect(Object.keys(decision?.payload ?? {}).sort()).toEqual(
        ["call_id", "decision", "reason_code", "rule_id", "tier", "version"].sort(),
      );
    });
  },
);
