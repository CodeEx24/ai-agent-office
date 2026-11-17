// @vitest-environment node
// AGO-126 live proof against the local Supabase stack (real RLS, real Realtime). It needs the shared stack, so it
// only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-126 --wait-min 120 && pnpm exec supabase db reset
//   RUN_DB_TESTS=1 pnpm --filter @ago/web exec vitest run src/features/office/realtime/office-realtime.live.test.ts
//   node scripts/db-lock.mjs release AGO-126
// It needs the migration that adds public.run_events to the supabase_realtime publication.
// AC1: a dropped connection catches up, in order, each event once. AC2: another workspace's events never arrive.
// Keys come from `supabase status` at run time and are never printed. Test passwords are built at runtime.
import { execFile, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, OfficeState } from "@ago/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSupabaseOfficeSource } from "./supabase-office-source";
import { createOfficeRealtime } from "./office-realtime";

const run = promisify(execFile);
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_agent-office";
const enabled = process.env.RUN_DB_TESTS === "1";

async function psql(sql: string): Promise<string> {
  const { stdout } = await run("docker", [
    "exec",
    "-i",
    DB_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-At",
    "-c",
    sql,
  ]);
  return stdout.trim();
}

function localStackEnv(): { url: string; serviceKey: string; anonKey: string } {
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const read = (name: string): string =>
    new RegExp(`^${name}="?([^"\\r\\n]+)"?`, "m").exec(out)?.[1] ?? "";
  return { url: read("API_URL"), serviceKey: read("SERVICE_ROLE_KEY"), anonKey: read("ANON_KEY") };
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!enabled)("AGO-126 realtime delivery (live)", () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const password = ["pw", randomUUID()].join("-");
  const stack = enabled ? localStackEnv() : { url: "", serviceKey: "", anonKey: "" };
  const userIds: string[] = [];
  let clientA: SupabaseClient<Database>;

  const insertEvent = (ws: string, runId: string, agentId: string, seq: number): Promise<string> =>
    psql(
      `insert into public.run_events (workspace_id, run_id, type, payload) values ('${ws}', '${runId}', ` +
        (seq === 1
          ? `'run.created', '{"version":1,"agent_id":"${agentId}","task_id":null}'`
          : `'run.started', '{"version":1}'`) +
        ")",
    );

  async function createUser(label: string): Promise<{ id: string; email: string }> {
    const email = `ago126-${label}-${randomUUID()}@example.test`;
    const res = await fetch(`${stack.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: stack.serviceKey,
        Authorization: `Bearer ${stack.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const body = (await res.json()) as { id: string };
    userIds.push(body.id);
    return { id: body.id, email };
  }

  beforeAll(async () => {
    const userA = await createUser("a");
    await psql(`
      insert into public.workspaces (id, name) values ('${wsA}', 'AGO-126 A'), ('${wsB}', 'AGO-126 B');
      insert into public.members (workspace_id, user_id, role) values ('${wsA}', '${userA.id}', 'member');
      insert into public.agents (id, workspace_id, name) values ('${agentA}', '${wsA}', 'a'), ('${agentB}', '${wsB}', 'b');
      insert into public.runs (id, workspace_id, agent_id) values ('${runA}', '${wsA}', '${agentA}'), ('${runB}', '${wsB}', '${agentB}')`);
    clientA = createClient<Database>(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await clientA.auth.signInWithPassword({ email: userA.email, password });
    if (error) throw new Error("test sign-in failed");
  });

  afterAll(async () => {
    if (!enabled) return;
    await clientA.removeAllChannels();
    await clientA.realtime.disconnect();
    const ids = `'${wsA}', '${wsB}'`;
    // Test-only teardown (run_events is append-only): see scripts/run-events-teardown.mjs.
    await psql(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.workspaces where id in (${ids});
      delete from auth.users where id in (${userIds.map((u) => `'${u}'`).join(", ")});
      commit;`);
  });

  it("AC2: catch-up never returns another workspace's rows, even when asked for them", async () => {
    await insertEvent(wsA, runA, agentA, 1);
    await insertEvent(wsB, runB, agentB, 1);
    const source = createSupabaseOfficeSource(clientA);
    const own = await source.fetchEvents({
      workspaceId: wsA,
      since: null,
      after: null,
      limit: 100,
    });
    expect(own).toHaveLength(1);
    const asked = await source.fetchEvents({
      workspaceId: wsB,
      since: null,
      after: null,
      limit: 100,
    });
    expect(asked).toEqual([]); // RLS, not the filter, is what answers here
    const gap = await source.fetchRunEvents({
      workspaceId: wsB,
      runId: runB,
      afterSeq: 0,
      limit: 100,
    });
    expect(gap).toEqual([]);
  });

  it("AC1+AC2: a subscriber in A never receives B's inserts; after a drop the missed events arrive in order, once each", async () => {
    const states: OfficeState[] = [];
    const statuses: string[] = [];
    const controller = createOfficeRealtime({
      source: createSupabaseOfficeSource(clientA),
      workspaceId: wsA,
      onState: (s) => states.push(s),
      onStatus: (s) => statuses.push(s),
      backoff: { baseMs: 200, maxMs: 1000 },
    });
    controller.start();
    await waitFor(() => controller.getStatus() === "live");
    const lastSeq = (): number => controller.getState().runs[runA]?.last_seq ?? 0;
    await waitFor(() => lastSeq() === 1); // the row inserted by the previous test, caught up

    // Live: A's insert arrives, B's never does.
    await insertEvent(wsA, runA, agentA, 2);
    await insertEvent(wsB, runB, agentB, 2);
    await waitFor(() => lastSeq() === 2);

    // Drop the connection, insert while down (also a row of B), then let it come back.
    await clientA.realtime.disconnect();
    await insertEvent(wsA, runA, agentA, 3);
    await insertEvent(wsB, runB, agentB, 3);
    await insertEvent(wsA, runA, agentA, 4);
    await waitFor(() => lastSeq() === 4);
    await waitFor(() => controller.getStatus() === "live");

    const state = controller.getState();
    expect(Object.keys(state.runs)).toEqual([runA]); // B's run never reached the state
    expect(state.anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
    expect(state.gaps).toEqual({});
    // Applied once each, in order: the run's last_seq only ever moved forward by whole steps.
    const seen = states.map((s) => s.runs[runA]?.last_seq ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    controller.stop();
  }, 90_000);
});
