// AGO-81 integration test: the real Postgres HandoffStore against public.tasks and the two handoff functions. It skips
// itself when the shared local Supabase stack is down. Run it inside the db lock, after a reset:
//   node scripts/db-lock.mjs acquire AGO-81 ... pnpm exec supabase db reset ... release AGO-81
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL } from "../config.js";
import { createPgRunEventStore, createRunEventEmitter } from "../events/index.js";
import { createHandoffPolicyHook } from "../policy/handoff-policy-hook.js";
import { createPgPolicySource } from "../policy/pg-policy-source.js";

import { createHandoff } from "./create-handoff.js";
import { createPgHandoffStore } from "./pg-handoff-store.js";

import type { PolicyContext, PolicyToolCall } from "../agent/policy-hook.js";

const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

async function isDatabaseUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select handoff_depth from public.tasks limit 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const live = await isDatabaseUp();
const SIGNAL = new AbortController().signal;

describe.skipIf(!live)("Postgres handoff store (live database)", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  const ws = randomUUID();
  const user = randomUUID();
  const member = randomUUID();
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const rootTask = randomUUID();
  const runA = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query("insert into public.workspaces (id, name) values ($1, 'AGO-81 test')", [ws]);
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
      [user, `ago81-${user}@example.test`],
    );
    await pool.query(
      "insert into public.members (id, workspace_id, user_id, role) values ($1, $2, $3, 'member')",
      [member, ws, user],
    );
    for (const [id, name] of [
      [a, "A"],
      [b, "B"],
      [c, "C"],
    ] as const) {
      await pool.query("insert into public.agents (id, workspace_id, name) values ($1, $2, $3)", [
        id,
        ws,
        name,
      ]);
    }
    await pool.query(
      `insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled) values
         ($1, 'vault.read', 'Read vault', 0, 'workspace', 'automatic', true),
         ($1, 'tasks.manage', 'Manage tasks', 1, 'workspace', 'automatic', true)
       on conflict (workspace_id, key) do update set tier = excluded.tier, enabled = true`,
      [ws],
    );
    // The sender A holds vault.read only. B also holds tasks.manage.
    await pool.query(
      `insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode) values
         ($1, $2, 'vault.read', 0, 'automatic'),
         ($1, $3, 'vault.read', 0, 'automatic'),
         ($1, $3, 'tasks.manage', 1, 'automatic')`,
      [ws, a, b],
    );
    await pool.query(
      "insert into public.tasks (id, workspace_id, title, agent_id, created_by) values ($1, $2, 'root', $3, $4)",
      [rootTask, ws, a, member],
    );
    await pool.query(
      "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, $3, $4)",
      [runA, ws, rootTask, a],
    );
  });

  afterAll(async () => {
    await pool.query("delete from public.workspaces where id = $1", [ws]).catch(() => undefined);
    await pool.query("delete from auth.users where id = $1", [user]).catch(() => undefined);
    await pool.end();
  });

  const emitterFor = (runId: string) =>
    createRunEventEmitter({ workspaceId: ws, runId, store: createPgRunEventStore(pool) });
  const call = (capabilityKey: string, tier: PolicyToolCall["tier"]): PolicyToolCall => ({
    callId: "call-1",
    toolName: "tool",
    input: {},
    capabilityKey,
    tier,
    isRegistered: true,
  });
  const context = (runId: string, agentId: string): PolicyContext => ({
    workspaceId: ws,
    runId,
    agentId,
    step: 1,
    signal: SIGNAL,
  });

  it("reads a party and the chain of a human task, and nothing across workspaces", async () => {
    const store = createPgHandoffStore(pool);
    const party = await store.loadParty(ws, a);
    expect(party?.isArchived).toBe(false);
    expect(party?.grants.map((g) => g.capabilityKey)).toEqual(["vault.read"]);
    expect(party?.dataScope).toEqual([]);
    expect(await store.loadParty(randomUUID(), a)).toBeNull();
    expect(await store.loadChainForRun(ws, runA)).toEqual({
      workspaceId: ws,
      requesterMemberId: member,
      path: [a],
    });
    expect(await store.loadChainForRun(randomUUID(), runA)).toBeNull();
  });

  it("refuses an over-broad handoff and writes nothing", async () => {
    const store = createPgHandoffStore(pool);
    const result = await createHandoff(
      { store, emitter: emitterFor(runA) },
      { workspaceId: ws, runId: runA, agentId: a },
      { to_agent_id: b, title: "t", requested: { capabilities: ["tasks.manage"] } },
    );
    expect(result).toEqual({ ok: false, reason: "widening_capability" });
    const rows = await pool.query(
      "select count(*)::int as n from public.tasks where workspace_id = $1 and handoff_from_agent_id is not null",
      [ws],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("creates a handoff task, accepts it once, and clamps the receiver's run through the policy hook", async () => {
    const store = createPgHandoffStore(pool);
    const made = await createHandoff(
      { store, emitter: emitterFor(runA) },
      { workspaceId: ws, runId: runA, agentId: a },
      { to_agent_id: b, title: "Summarise", description: "notes" },
    );
    if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
    expect(made.depth).toBe(1);

    const record = await store.findByTask(ws, made.taskId);
    expect(record).toMatchObject({
      fromAgentId: a,
      toAgentId: b,
      requesterMemberId: member,
      path: [a, b],
      depth: 1,
      acceptedByRunId: null,
    });
    expect(record?.narrowed.capabilities.map((g) => g.capabilityKey)).toEqual(["vault.read"]);

    const runB = randomUUID();
    await pool.query(
      "insert into public.runs (id, workspace_id, task_id, agent_id) values ($1, $2, $3, $4)",
      [runB, ws, made.taskId, b],
    );
    expect(await store.markAccepted(ws, made.taskId, runB)).toBe(true);
    expect(await store.markAccepted(ws, made.taskId, runB)).toBe(false);
    expect((await store.findByRun(ws, runB))?.taskId).toBe(made.taskId);
    expect(await store.loadChainForRun(ws, runB)).toEqual({
      workspaceId: ws,
      requesterMemberId: member,
      path: [a, b],
    });

    // B holds tasks.manage itself, but A did not pass it on: the receiver's run is clamped.
    const hook = createHandoffPolicyHook({ source: createPgPolicySource(pool), store });
    expect((await hook.check(call("vault.read", 0), context(runB, b))).decision).toBe("allow");
    expect(await hook.check(call("tasks.manage", 1), context(runB, b))).toMatchObject({
      decision: "deny",
      reasonCode: "not_granted",
    });
    // An ordinary run of B keeps its own grants.
    expect((await hook.check(call("tasks.manage", 1), context(randomUUID(), b))).decision).toBe(
      "allow",
    );

    // A cycle (B hands back to A) is refused before the database is asked.
    const cycle = await createHandoff(
      { store, emitter: emitterFor(runB) },
      { workspaceId: ws, runId: runB, agentId: b },
      { to_agent_id: a, title: "back" },
    );
    expect(cycle).toEqual({ ok: false, reason: "cycle" });
  });
});
