// AGO-34 integration test: the policy engine loads grants and layered policies from the real database
// (AGO-96 `policies`, AGO-141 `agent_capabilities`, AGO-125 `capabilities`). No model, no network.
// It skips itself when the shared local Supabase stack is down, so CI without Docker stays green.
// Run it inside the db lock:  node scripts/db-lock.mjs acquire AGO-34 ... release AGO-34
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";

import { createPgPolicySource } from "./pg-policy-source.js";
import { createPolicyEngineHook } from "./policy-engine-hook.js";

import type { PolicyToolCall } from "../agent/policy-hook.js";

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
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const DEPARTMENT = randomUUID();

const call = (capabilityKey: string, tier: PolicyToolCall["tier"]): PolicyToolCall => ({
  callId: "c1",
  toolName: "some_tool",
  input: {},
  tier,
  capabilityKey,
  isRegistered: true,
});

describe.skipIf(!live)("policy engine against the database", { timeout: 30_000 }, () => {
  let pool: pg.Pool;

  const context = (agentId = AGENT, workspaceId = WORKSPACE) => ({
    workspaceId,
    runId: randomUUID(),
    agentId,
    step: 1,
    signal: new AbortController().signal,
  });
  const check = (capabilityKey: string, tier: PolicyToolCall["tier"], agentId = AGENT) =>
    createPolicyEngineHook({ source: createPgPolicySource(pool) }).check(
      call(capabilityKey, tier),
      context(agentId),
    );
  const setPolicy = (level: string, scopeId: string | null, rules: unknown) =>
    pool.query(
      `insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5)`,
      [WORKSPACE, level, scopeId, JSON.stringify(rules), MEMBER],
    );
  const clearPolicies = () =>
    pool.query("delete from public.policies where workspace_id = $1", [WORKSPACE]);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    // Workspace creation seeds the capability catalog (AGO-125).
    for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
      await pool.query(
        "insert into public.workspaces (id, name) values ($1, 'AGO-34 policy test')",
        [id],
      );
    }
    await pool.query("insert into auth.users (id) values ($1)", [USER]);
    await pool.query(
      "insert into public.members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')",
      [MEMBER, WORKSPACE, USER],
    );
    await pool.query(
      `insert into public.agents (id, workspace_id, name, department_id) values ($1, $2, 'engine', $3)`,
      [AGENT, WORKSPACE, DEPARTMENT],
    );
    await pool.query(
      `insert into public.agents (id, workspace_id, name) values ($1, $2, 'bystander')`,
      [OTHER_AGENT, WORKSPACE],
    );
    // Grants: vault.read (tier 0), web.search (tier 1), vault.write_own (tier 2), code.run (tier 3, approval).
    for (const [key, tier, mode] of [
      ["vault.read", 0, "automatic"],
      ["web.search", 1, "automatic"],
      ["vault.write_own", 2, "automatic"],
      ["code.run", 3, "approval"],
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
    await pool.query("delete from public.agents where workspace_id = $1", [WORKSPACE]);
    await pool.query("delete from public.members where workspace_id = $1", [WORKSPACE]);
    await pool.query("delete from public.workspaces where id = any($1)", [
      [WORKSPACE, OTHER_WORKSPACE],
    ]);
    await pool.query("delete from auth.users where id = $1", [USER]);
    await pool.end();
  });

  it("applies tier defaults from the stored grants and the strict agent mode", async () => {
    await clearPolicies();
    expect(await check("vault.read", 0)).toMatchObject({ decision: "allow" });
    expect(await check("web.search", 1)).toMatchObject({ decision: "allow" });
    expect(await check("vault.write_own", 2)).toMatchObject({
      decision: "needs_approval",
      reasonCode: "strict_mode_tier2",
    });
    expect(await check("code.run", 3)).toMatchObject({
      decision: "needs_approval",
      reasonCode: "tier_requires_approval",
    });
  });

  it("AC3: denies a capability the agent was never granted, and one in another agent's grants", async () => {
    await clearPolicies();
    expect(await check("message.send_outbound", 4)).toEqual({
      decision: "deny",
      reasonCode: "not_granted",
    });
    expect(await check("vault.read", 0, OTHER_AGENT)).toEqual({
      decision: "deny",
      reasonCode: "not_granted",
    });
  });

  it("AC3: a baseline deny stored in the database denies, and a lifted policy stops denying", async () => {
    await clearPolicies();
    await setPolicy("baseline", null, {
      version: 1,
      rules: [{ action: "web.*", effect: "deny" }],
    });
    const denied = await check("web.search", 1);
    expect(denied).toMatchObject({ decision: "deny", reasonCode: "deny_rule" });
    expect(denied.ruleId).toMatch(/^[0-9a-f-]{36}:0$/);

    await pool.query("update public.policies set archived_at = now() where workspace_id = $1", [
      WORKSPACE,
    ]);
    expect(await check("web.search", 1)).toMatchObject({ decision: "allow" });
  });

  it("AC2: a department deny wins over an agent-level allow", async () => {
    await clearPolicies();
    await setPolicy("department", DEPARTMENT, {
      version: 1,
      rules: [{ action: "vault.read", effect: "deny" }],
    });
    await setPolicy("agent", AGENT, {
      version: 1,
      rules: [{ action: "vault.read", effect: "allow" }],
    });
    expect(await check("vault.read", 0)).toMatchObject({
      decision: "deny",
      reasonCode: "deny_rule",
    });
    // The bystander has no department and no grant: the department deny does not reach it.
    expect(await check("vault.read", 0, OTHER_AGENT)).toMatchObject({ reasonCode: "not_granted" });
  });

  it("an agent policy for a different agent does not apply", async () => {
    await clearPolicies();
    await setPolicy("agent", OTHER_AGENT, {
      version: 1,
      rules: [{ action: "*", effect: "deny" }],
    });
    expect(await check("vault.read", 0)).toMatchObject({ decision: "allow" });
  });

  it("a disabled catalog capability is denied even though the grant exists", async () => {
    await clearPolicies();
    await pool.query(
      "update public.capabilities set enabled = false where workspace_id = $1 and key = 'vault.read'",
      [WORKSPACE],
    );
    try {
      expect(await check("vault.read", 0)).toEqual({ decision: "deny", reasonCode: "not_granted" });
    } finally {
      await pool.query(
        "update public.capabilities set enabled = true where workspace_id = $1 and key = 'vault.read'",
        [WORKSPACE],
      );
    }
  });

  it("fails closed on a stored policy that does not match the rule schema", async () => {
    await clearPolicies();
    await setPolicy("baseline", null, { version: 1, rules: [{ action: "x", effect: "maybe" }] });
    expect(await check("vault.read", 0)).toEqual({
      decision: "deny",
      reasonCode: "policy_invalid",
    });
  });

  it("throws (the loop then denies) for an agent that is not in the workspace", async () => {
    const hook = createPolicyEngineHook({ source: createPgPolicySource(pool) });
    await expect(
      hook.check(call("vault.read", 0), context(randomUUID(), OTHER_WORKSPACE)),
    ).rejects.toThrow(/agent not found/);
  });
});
