// @vitest-environment node
// AGO-126 live acceptance tests (functional tester) against the local Supabase stack: real RLS, real Realtime.
// Only runs with RUN_DB_TESTS=1 and inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-126 --wait-min 120 && pnpm exec supabase db reset
//   cd apps/web && RUN_DB_TESTS=1 pnpm exec vitest run src/features/office/realtime/office-realtime.acceptance.live.test.ts
//   node scripts/db-lock.mjs release AGO-126
// There is no HTTP catch-up route in AGO-126: the browser reads run_events through RLS with the user-scoped client,
// so "who may read" is proven here with an anonymous client, a non-member and a member of another workspace.
// Keys come from `supabase status` at run time and are never printed. Passwords are built at runtime.
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

async function waitFor(check: () => boolean, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)("AGO-126 acceptance (live)", () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const runA1 = randomUUID();
  const runA2 = randomUUID();
  const runB = randomUUID();
  const password = ["pw", randomUUID()].join("-");
  const stack = enabled ? localStackEnv() : { url: "", serviceKey: "", anonKey: "" };
  const userIds: string[] = [];
  const clients: SupabaseClient<Database>[] = [];
  let clientA: SupabaseClient<Database>;
  let clientB: SupabaseClient<Database>;
  let clientNoMember: SupabaseClient<Database>;
  let clientAnon: SupabaseClient<Database>;

  const insertSql = (ws: string, runId: string, agentId: string, seq: number): string =>
    `insert into public.run_events (workspace_id, run_id, type, payload) values ('${ws}', '${runId}', ` +
    (seq === 1
      ? `'run.created', '{"version":1,"agent_id":"${agentId}","task_id":null}'`
      : `'run.started', '{"version":1}'`) +
    ")";
  const insertEvent = (ws: string, runId: string, agentId: string, seq: number): Promise<string> =>
    psql(insertSql(ws, runId, agentId, seq));

  const newClient = (key = stack.anonKey): SupabaseClient<Database> => {
    const c = createClient<Database>(stack.url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clients.push(c);
    return c;
  };

  async function signedInClient(
    label: string,
  ): Promise<{ client: SupabaseClient<Database>; id: string }> {
    const email = `ago126acc-${label}-${randomUUID()}@example.test`;
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
    const client = newClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error("test sign-in failed");
    return { client, id: body.id };
  }

  beforeAll(async () => {
    const a = await signedInClient("a");
    const b = await signedInClient("b");
    const n = await signedInClient("nomember");
    clientA = a.client;
    clientB = b.client;
    clientNoMember = n.client;
    clientAnon = newClient();
    await psql(`
      insert into public.workspaces (id, name) values ('${wsA}', 'AGO-126 acc A'), ('${wsB}', 'AGO-126 acc B');
      insert into public.members (workspace_id, user_id, role) values ('${wsA}', '${a.id}', 'member'), ('${wsB}', '${b.id}', 'member');
      insert into public.agents (id, workspace_id, name) values ('${agentA}', '${wsA}', 'a'), ('${agentB}', '${wsB}', 'b');
      insert into public.runs (id, workspace_id, agent_id) values ('${runA1}', '${wsA}', '${agentA}'), ('${runA2}', '${wsA}', '${agentA}'), ('${runB}', '${wsB}', '${agentB}')`);
  });

  afterAll(async () => {
    if (!enabled) return;
    for (const c of clients) {
      await c.removeAllChannels();
      await c.realtime.disconnect();
    }
    const ids = `'${wsA}', '${wsB}'`;
    await psql(`
      begin;
      alter table public.run_events disable trigger run_events_block_update_delete;
      delete from public.run_events where workspace_id in (${ids});
      alter table public.run_events enable always trigger run_events_block_update_delete;
      delete from public.workspaces where id in (${ids});
      delete from auth.users where id in (${userIds.map((u) => `'${u}'`).join(", ")});
      commit;`);
  });

  describe("AC2: rows other workspaces own are never readable through the source", () => {
    it("gives an anonymous client no rows, even when it names the workspace (denied or empty)", async () => {
      await insertEvent(wsA, runA1, agentA, 1);
      const source = createSupabaseOfficeSource(clientAnon);
      const outcome = async (p: Promise<readonly unknown[]>): Promise<readonly unknown[]> =>
        p.catch(() => []); // anon has no table grant: a rejection is also "no rows"
      expect(
        await outcome(
          source.fetchEvents({ workspaceId: wsA, since: null, after: null, limit: 50 }),
        ),
      ).toEqual([]);
      expect(
        await outcome(
          source.fetchRunEvents({ workspaceId: wsA, runId: runA1, afterSeq: 0, limit: 50 }),
        ),
      ).toEqual([]);
    });

    it("returns nothing to a signed-in user who is not a member of the workspace", async () => {
      const source = createSupabaseOfficeSource(clientNoMember);
      expect(
        await source.fetchEvents({ workspaceId: wsA, since: null, after: null, limit: 50 }),
      ).toEqual([]);
    });

    it("returns each member only their own workspace's rows, with the agent joined", async () => {
      await insertEvent(wsB, runB, agentB, 1);
      const a = await createSupabaseOfficeSource(clientA).fetchEvents({
        workspaceId: wsA,
        since: null,
        after: null,
        limit: 50,
      });
      const b = await createSupabaseOfficeSource(clientB).fetchEvents({
        workspaceId: wsB,
        since: null,
        after: null,
        limit: 50,
      });
      expect(a.map((r) => (r as { workspace_id: string }).workspace_id)).toEqual([wsA]);
      expect(b.map((r) => (r as { workspace_id: string }).workspace_id)).toEqual([wsB]);
      expect((a[0] as { agent_id: string }).agent_id).toBe(agentA);
      const cross = await createSupabaseOfficeSource(clientA).fetchEvents({
        workspaceId: wsB,
        since: null,
        after: null,
        limit: 50,
      });
      expect(cross).toEqual([]);
      const crossRun = await createSupabaseOfficeSource(clientB).fetchRunEvents({
        workspaceId: wsA,
        runId: runA1,
        afterSeq: 0,
        limit: 50,
      });
      expect(crossRun).toEqual([]);
    });

    it("never delivers a stream row to an anonymous or non-member subscriber", async () => {
      const received: OfficeState[] = [];
      const controller = createOfficeRealtime({
        source: createSupabaseOfficeSource(clientNoMember),
        workspaceId: wsA,
        onState: (s) => received.push(s),
        backoff: { baseMs: 200, maxMs: 1000 },
      });
      controller.start();
      await waitFor(() => controller.getStatus() === "live");
      await insertEvent(wsA, runA1, agentA, 2);
      await sleep(2500);
      expect(controller.getState().runs).toEqual({});
      expect(received).toHaveLength(0);
      controller.stop();
    }, 60_000);

    it("keeps two live subscribers apart: each sees only its own workspace, in order, once", async () => {
      const mk = (
        client: SupabaseClient<Database>,
        ws: string,
      ): { c: ReturnType<typeof createOfficeRealtime>; states: OfficeState[] } => {
        const states: OfficeState[] = [];
        const c = createOfficeRealtime({
          source: createSupabaseOfficeSource(client),
          workspaceId: ws,
          onState: (s) => states.push(s),
          backoff: { baseMs: 200, maxMs: 1000 },
        });
        return { c, states };
      };
      const sa = mk(clientA, wsA);
      const sb = mk(clientB, wsB);
      sa.c.start();
      sb.c.start();
      await waitFor(() => sa.c.getStatus() === "live" && sb.c.getStatus() === "live");
      const seqA = (): number => sa.c.getState().runs[runA1]?.last_seq ?? 0;
      const seqB = (): number => sb.c.getState().runs[runB]?.last_seq ?? 0;
      const a0 = seqA();
      const b0 = seqB();
      await insertEvent(wsA, runA1, agentA, 99);
      await insertEvent(wsB, runB, agentB, 99);
      await waitFor(() => seqA() === a0 + 1 && seqB() === b0 + 1);
      expect(Object.keys(sa.c.getState().runs)).toEqual([runA1]);
      expect(Object.keys(sb.c.getState().runs)).toEqual([runB]);
      expect(sa.c.getState().anomalies.foreign).toBe(0);
      expect(sb.c.getState().anomalies.foreign).toBe(0);
      sa.c.stop();
      sb.c.stop();
    }, 60_000);
  });

  describe("AC1: a dropped connection catches up", () => {
    it("applies rows that committed out of created_at order while the connection was down, each once", async () => {
      const states: OfficeState[] = [];
      const controller = createOfficeRealtime({
        source: createSupabaseOfficeSource(clientA),
        workspaceId: wsA,
        onState: (s) => states.push(s),
        backoff: { baseMs: 200, maxMs: 1000 },
      });
      controller.start();
      await waitFor(() => controller.getStatus() === "live");
      const seq = (id: string): number => controller.getState().runs[id]?.last_seq ?? 0;
      const base1 = seq(runA1);

      await clientA.realtime.disconnect();
      // Run A2's transaction starts first (earlier created_at) but commits last.
      const slow = psql(`begin; ${insertSql(wsA, runA2, agentA, 1)}; select pg_sleep(2); commit;`);
      await sleep(500);
      await insertEvent(wsA, runA1, agentA, 100); // commits first, later created_at
      await insertEvent(wsA, runA1, agentA, 101);
      await slow;

      await waitFor(() => seq(runA2) === 1 && seq(runA1) === base1 + 2);
      await waitFor(() => controller.getStatus() === "live");

      const state = controller.getState();
      expect(state.gaps).toEqual({});
      expect(state.anomalies).toEqual({ unsupported: 0, invalid: 0, foreign: 0 });
      const seen = states.map(
        (s) => (s.runs[runA1]?.last_seq ?? 0) * 1000 + (s.runs[runA2]?.last_seq ?? 0),
      );
      expect(new Set(seen).size).toBe(seen.length); // no state emitted twice
      controller.stop();
    }, 90_000);

    it("never applies a missed row twice when stop() and start() are cycled", async () => {
      const controller = createOfficeRealtime({
        source: createSupabaseOfficeSource(clientA),
        workspaceId: wsA,
        onState: () => undefined,
        backoff: { baseMs: 200, maxMs: 1000 },
      });
      controller.start();
      await waitFor(() => controller.getStatus() === "live");
      controller.stop();
      const before = controller.getState().runs[runA1]?.last_seq ?? 0;
      await insertEvent(wsA, runA1, agentA, 200);
      controller.start();
      await waitFor(() => controller.getStatus() === "live");
      expect(controller.getState().runs[runA1]?.last_seq).toBe(before + 1);
      controller.stop();
    }, 60_000);
  });
});
