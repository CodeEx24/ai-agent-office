// AGO-164: the typed run event emitter against the real local database.
// Needs the shared local Supabase stack, so it only runs with RUN_DB_TESTS=1, inside the db lock:
//   node scripts/db-lock.mjs acquire AGO-164
//   RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/run-event-emitter.test.mjs
//   node scripts/db-lock.mjs release AGO-164
// It uses the BUILT worker and shared packages (`pnpm build` first; `pnpm test` builds the worker).
// Rows are removed at the end by the test-only teardown (scripts/run-events-teardown.mjs).

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teardownRunEventsSql } from "./run-events-teardown.mjs";

const enabled = process.env.RUN_DB_TESTS === "1";
const DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;

describe.skipIf(!enabled)("typed run event emitter (local database)", () => {
  const ws = { a: randomUUID(), b: randomUUID() };
  const user = { a: randomUUID(), b: randomUUID() };
  const agent = randomUUID();
  const run = { one: randomUUID(), two: randomUUID() };
  const HASH = "c".repeat(64);
  let pool;
  let emitterFor;
  let sharedLib;
  let RunEventValidationError;

  const count = async (runId) =>
    Number((await pool.query("select count(*) from public.run_events where run_id = $1", [runId])).rows[0].count);
  const seqs = async (runId) =>
    (await pool.query("select seq from public.run_events where run_id = $1 order by seq", [runId])).rows.map((r) =>
      Number(r.seq),
    );

  /** Read run_events as a signed-in user (RLS applies), inside a rolled-back transaction. */
  async function readAs(userId, runId) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      return (await client.query("select count(*)::int as n from public.run_events where run_id = $1", [runId])).rows[0].n;
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  beforeAll(async () => {
    const workerRequire = createRequire(new URL("../apps/worker/package.json", import.meta.url));
    const pg = workerRequire("pg");
    sharedLib = await import(new URL("../packages/shared/dist/index.js", import.meta.url).href);
    const worker = await import(new URL("../apps/worker/dist/events/index.js", import.meta.url).href);
    RunEventValidationError = worker.RunEventValidationError;
    pool = new pg.Pool({ connectionString: DB_URL, max: 20 });
    const store = worker.createPgRunEventStore(pool);
    emitterFor = (workspaceId, runId) => worker.createRunEventEmitter({ workspaceId, runId, store });

    const nil = "00000000-0000-0000-0000-000000000000";
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email) values
         ($1, $3, 'authenticated', 'authenticated', $4), ($2, $3, 'authenticated', 'authenticated', $5)`,
      [user.a, user.b, nil, `ago164-a-${user.a}@example.test`, `ago164-b-${user.b}@example.test`],
    );
    await pool.query(`insert into public.workspaces (id, name) values ($1, 'AGO-164 A'), ($2, 'AGO-164 B')`, [ws.a, ws.b]);
    await pool.query(
      `insert into public.members (workspace_id, user_id, role) values ($1, $3, 'viewer'), ($2, $4, 'viewer')`,
      [ws.a, ws.b, user.a, user.b],
    );
    await pool.query(`insert into public.agents (id, workspace_id, name) values ($1, $2, 'agent')`, [agent, ws.a]);
    await pool.query(
      `insert into public.runs (id, workspace_id, agent_id) values ($1, $3, $4), ($2, $3, $4)`,
      [run.one, run.two, ws.a, agent],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(teardownRunEventsSql([ws.a, ws.b]));
    await pool.query("delete from auth.users where id in ($1, $2)", [user.a, user.b]);
    await pool.end();
  });

  it("AC2: concurrent emits in one run get seq 1..N with no gaps, and a second run is independent", async () => {
    const one = emitterFor(ws.a, run.one);
    const two = emitterFor(ws.a, run.two);
    const results = await Promise.all([
      ...Array.from({ length: 40 }, (_, i) => one.emit({ type: "step.started", payload: { step: i + 1 } })),
      ...Array.from({ length: 15 }, () =>
        two.emit({ type: "budget.usage", payload: { input_tokens: 1, output_tokens: 2 } }),
      ),
    ]);
    expect(results).toHaveLength(55);
    expect(await seqs(run.one)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await seqs(run.two)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Returned seq values are exactly the stored ones (the emitter never invents them).
    expect(results.slice(0, 40).map((r) => r.seq).sort((x, y) => x - y)).toEqual(await seqs(run.one));
  });

  it("AC1: every stored event parses back through its Zod schema", async () => {
    const em = emitterFor(ws.a, run.one);
    await em.emit({
      type: "approval.requested",
      payload: { approval_id: "ap1", call_id: "c1", payload_hash: HASH, tier: 3, expires_at: "2026-11-06T12:00:00Z" },
    });
    const rows = (await pool.query("select type, payload from public.run_events where run_id = $1", [run.one])).rows;
    expect(rows.length).toBeGreaterThan(40);
    for (const row of rows) expect(sharedLib.parseStoredRunEvent(row)).not.toBeNull();
  });

  it("AC1: an invalid event is rejected and nothing is written", async () => {
    const before = await count(run.one);
    const em = emitterFor(ws.a, run.one);
    await expect(em.emit({ type: "step.started", payload: { step: -1 } })).rejects.toBeInstanceOf(
      RunEventValidationError,
    );
    await expect(em.emit({ type: "run.started", payload: { api_key: "sk-secret" } })).rejects.toBeInstanceOf(
      RunEventValidationError,
    );
    await expect(em.emit({ type: "nope", payload: {} })).rejects.toBeInstanceOf(RunEventValidationError);
    expect(await count(run.one)).toBe(before);
  });

  it("RLS: a member of the run's workspace can read the events, a user of another workspace sees none", async () => {
    expect(await readAs(user.a, run.one)).toBeGreaterThan(0);
    expect(await readAs(user.b, run.one)).toBe(0);
  });

  it("a run id from another workspace is refused by the database (nothing written)", async () => {
    const before = await count(run.one);
    const em = emitterFor(ws.b, run.one);
    await expect(em.emit({ type: "run.started", payload: {} })).rejects.toThrow(/could not write/);
    expect(await count(run.one)).toBe(before);
  });
});
