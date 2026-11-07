/**
 * AGO-164 acceptance tests (QA): the typed run event emitter. Non-UI ticket, so these are integration
 * tests written from the acceptance criteria, one `AC#:` test per criterion plus negative cases.
 *   AC1 every event matches a Zod schema
 *   AC2 sequence numbers increase without gaps within a run
 *   AC3 all events in the (coordinator-approved v1) event list are defined
 *
 * Run: `pnpm build` first (uses the built shared and worker packages), then
 *   node scripts/db-lock.mjs acquire AGO-164-qa
 *   pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-164-acceptance.test.mjs
 *   node scripts/db-lock.mjs release AGO-164-qa
 * Schema cases run everywhere. Cases that need the local Supabase Postgres are skipped, with a clear
 * reason, when nothing listens on it (CI), so the CI `test` job stays green; they always run locally.
 * Test rows are removed with the shared test-only teardown (scripts/run-events-teardown.mjs).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { teardownRunEventsSql } from "./run-events-teardown.mjs";

const SHARED_ENTRY = new URL("../packages/shared/dist/index.js", import.meta.url);
const WORKER_EVENTS = new URL("../apps/worker/dist/events/index.js", import.meta.url);
for (const url of [SHARED_ENTRY, WORKER_EVENTS]) {
  if (!existsSync(url)) throw new Error(`${url.pathname} is missing: run \`pnpm build\` first`);
}
const shared = await import(SHARED_ENTRY.href);
const worker = await import(WORKER_EVENTS.href);
const { runEventSchema, RUN_EVENT_TYPES, RUN_EVENT_SCHEMAS, parseStoredRunEvent, isApprovalGranted, toRunEventColumns } =
  shared;
const { createRunEventEmitter, createPgRunEventStore, RunEventValidationError, RunEventWriteError } = worker;

const DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;

function isPortOpen(port) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open) => {
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
const dbUp = await isPortOpen(DB_PORT);
const liveTest = test.skipIf(!dbUp);
if (!dbUp) console.warn(`AGO-164 live-DB cases skipped: no Postgres at 127.0.0.1:${DB_PORT} (start with \`supabase start\`)`);

const HASH = "a".repeat(64);
const UUID = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2030-01-01T00:00:00Z";

/** One valid payload per event type of the v1 list (24 approved in AGO-164, plus context.cut from AGO-167 = 25). */
const VALID = {
  "run.created": { agent_id: UUID, task_id: null },
  "run.started": {},
  "run.completed": { steps: 3, summary: "done" },
  "run.failed": { reason: "tool_error", message: "boom" },
  "run.paused": { requested_by: "human", reason: "user_request" },
  "run.resumed": { resumed_by: "human" },
  "run.stopped": { stopped_by: "human", reason: "user_request" },
  "run.limit_reached": { limit: "steps", max: 10, observed: 10 },
  "run.loop_detected": { tool_name: "search", call_hash: HASH, repeat_count: 3 },
  "context.cut": { section: "tool_result", source: "tool:search#c1", action: "truncated", original_chars: 150000, kept_chars: 20000 },
  "step.started": { step: 1 },
  "step.completed": { step: 1, outcome: "ok" },
  "tool_call.requested": { call_id: "c1", tool_name: "search", tier: 1, input_hash: HASH },
  "tool_call.started": { call_id: "c1" },
  "tool_call.completed": { call_id: "c1", duration_ms: 12, output_hash: HASH },
  "tool_call.failed": { call_id: "c1", error_code: "timeout", message: "slow" },
  "policy.decision": { call_id: "c1", decision: "allow", tier: 1, reason_code: "tier_1_auto" },
  "approval.requested": { approval_id: "ap1", call_id: "c1", payload_hash: HASH, tier: 3, expires_at: FUTURE },
  "approval.decided": { approval_id: "ap1", outcome: "approved", decided_by: "human", payload_hash: HASH },
  "budget.usage": { input_tokens: 10, output_tokens: 20 },
  "budget.exceeded": { scope: "run", limit: 100, used: 120 },
  "handoff.created": { handoff_id: "h1", to_agent_id: UUID, reason: "needs review" },
  "handoff.accepted": { handoff_id: "h1", by_agent_id: UUID },
  "error.raised": { code: "unexpected", message: "oops", retryable: false },
  "message.emitted": { role: "agent", summary: "hello" },
};
/** The coordinator-approved v1 list (docs/tickets/AGO-164.md). The source of truth for AC3. */
const V1_LIST = Object.keys(VALID);
const ev = (type, payload = VALID[type], version = 1) => ({ type, version, payload });

describe("AC1: every event matches a Zod schema", () => {
  test("AC1: every one of the 24 event types accepts its valid sample", () => {
    expect(V1_LIST).toHaveLength(25);
    for (const type of V1_LIST) {
      const result = runEventSchema.safeParse(ev(type));
      expect(result.success, `${type} should be valid`).toBe(true);
    }
  });

  test("AC1: every event type rejects an extra field (a stray secret cannot ride along)", () => {
    for (const type of V1_LIST) {
      const result = runEventSchema.safeParse(ev(type, { ...VALID[type], api_key: "sk-secret" }));
      expect(result.success, `${type} should reject unknown keys`).toBe(false);
    }
  });

  test("AC1: every event type rejects an empty payload and a missing required field", () => {
    for (const type of V1_LIST) {
      const keys = Object.keys(VALID[type]);
      if (keys.length === 0) continue; // run.started has no fields
      expect(runEventSchema.safeParse(ev(type, {})).success, `${type} empty payload`).toBe(false);
      for (const key of keys) {
        const rest = Object.fromEntries(Object.entries(VALID[type]).filter(([k]) => k !== key));
        const optional =
          (type === "run.completed" && key === "summary") || (type === "tool_call.completed" && key === "output_hash");
        expect(runEventSchema.safeParse(ev(type, rest)).success, `${type} without ${key}`).toBe(optional);
      }
    }
  });

  test("AC1: wrong-typed values are rejected", () => {
    const bad = [
      ["step.started", { step: "1" }],
      ["step.started", { step: 0 }],
      ["step.started", { step: 1.5 }],
      ["tool_call.requested", { ...VALID["tool_call.requested"], tier: 5 }],
      ["tool_call.requested", { ...VALID["tool_call.requested"], input_hash: "nothex" }],
      ["tool_call.requested", { ...VALID["tool_call.requested"], input_hash: "A".repeat(64) }],
      ["policy.decision", { ...VALID["policy.decision"], decision: "maybe" }],
      ["run.created", { agent_id: "not-a-uuid", task_id: null }],
      ["budget.usage", { input_tokens: -1, output_tokens: 0 }],
      ["error.raised", { ...VALID["error.raised"], retryable: "no" }],
      ["run.loop_detected", { ...VALID["run.loop_detected"], repeat_count: 1 }],
      ["approval.requested", { ...VALID["approval.requested"], expires_at: "tomorrow" }],
    ];
    for (const [type, payload] of bad) {
      expect(runEventSchema.safeParse(ev(type, payload)).success, `${type} ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  test("AC1: oversized fields are rejected", () => {
    expect(runEventSchema.safeParse(ev("message.emitted", { role: "agent", summary: "x".repeat(2_001) })).success).toBe(false);
    expect(runEventSchema.safeParse(ev("message.emitted", { role: "agent", summary: "x".repeat(2_000) })).success).toBe(true);
    expect(runEventSchema.safeParse(ev("run.failed", { reason: "r", message: "m".repeat(501) })).success).toBe(false);
    expect(runEventSchema.safeParse(ev("tool_call.started", { call_id: "c".repeat(129) })).success).toBe(false);
    expect(runEventSchema.safeParse(ev("run.failed", { reason: "x".repeat(101), message: "m" })).success).toBe(false);
  });

  test("AC1: unknown types, missing version and wrong version are rejected", () => {
    expect(runEventSchema.safeParse(ev("run.exploded", {})).success).toBe(false);
    expect(runEventSchema.safeParse(ev("", {})).success).toBe(false);
    expect(runEventSchema.safeParse({ payload: {} }).success).toBe(false);
    expect(runEventSchema.safeParse({ type: "run.started", payload: {} }).success).toBe(false);
    expect(runEventSchema.safeParse(ev("run.started", {}, 2)).success).toBe(false);
    expect(runEventSchema.safeParse(ev("run.started", {}, "1")).success).toBe(false);
    for (const junk of [null, undefined, 42, "run.started", [], { type: 5 }]) {
      expect(runEventSchema.safeParse(junk).success).toBe(false);
    }
  });

  test("AC1: an event cannot record an agent or timeout approving, or an agent resuming a run", () => {
    const decided = (outcome, decided_by) => ev("approval.decided", { ...VALID["approval.decided"], outcome, decided_by });
    expect(runEventSchema.safeParse(decided("approved", "human")).success).toBe(true);
    expect(runEventSchema.safeParse(decided("denied", "human")).success).toBe(true);
    expect(runEventSchema.safeParse(decided("expired", "timeout")).success).toBe(true);
    expect(runEventSchema.safeParse(decided("approved", "timeout")).success).toBe(false);
    expect(runEventSchema.safeParse(decided("denied", "timeout")).success).toBe(false);
    expect(runEventSchema.safeParse(decided("expired", "human")).success).toBe(false);
    expect(runEventSchema.safeParse(decided("approved", "agent")).success).toBe(false);
    expect(runEventSchema.safeParse(ev("run.resumed", { resumed_by: "agent" })).success).toBe(false);
    expect(runEventSchema.safeParse(ev("run.resumed", { resumed_by: "system" })).success).toBe(false);
  });

  test("AC1: a stored row parses back, and rows that are not v1 events parse to null", () => {
    for (const type of V1_LIST) {
      const columns = toRunEventColumns(runEventSchema.parse(ev(type)));
      expect(parseStoredRunEvent(columns), `${type} round trip`).not.toBeNull();
    }
    expect(parseStoredRunEvent({ type: "test", payload: {} })).toBeNull();
    expect(parseStoredRunEvent({ type: "run.started", payload: {} })).toBeNull();
    expect(parseStoredRunEvent({ type: "run.started", payload: { version: 2 } })).toBeNull();
    expect(parseStoredRunEvent({ type: "run.started", payload: { version: 1, extra: 1 } })).toBeNull();
  });
});

describe("AC3: all events in the v1 event list are defined", () => {
  test("AC3: every type of the approved v1 list exists and nothing else is defined", () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...V1_LIST].sort());
    expect(RUN_EVENT_SCHEMAS).toHaveLength(25);
    expect(new Set(RUN_EVENT_TYPES).size).toBe(25);
  });

  test("AC3: approval.requested carries payload_hash (and it must be a sha256)", () => {
    expect(runEventSchema.safeParse(ev("approval.requested")).success).toBe(true);
    const without = Object.fromEntries(Object.entries(VALID["approval.requested"]).filter(([k]) => k !== "payload_hash"));
    expect(runEventSchema.safeParse(ev("approval.requested", without)).success).toBe(false);
    expect(runEventSchema.safeParse(ev("approval.requested", { ...VALID["approval.requested"], payload_hash: "abc" })).success).toBe(false);
  });

  test("AC3: approval.decided 'expired' is a deny (timeout means deny); only 'approved' grants", () => {
    const payloadFor = (outcome, decided_by) => ({ ...VALID["approval.decided"], outcome, decided_by });
    expect(isApprovalGranted(payloadFor("approved", "human"))).toBe(true);
    expect(isApprovalGranted(payloadFor("denied", "human"))).toBe(false);
    expect(isApprovalGranted(payloadFor("expired", "timeout"))).toBe(false);
  });
});

describe("emitter safety (no database)", () => {
  const WS = randomUUID();
  const RUN = randomUUID();

  test("AC1: the emitter validates before writing and never leaks values in errors or logs", async () => {
    const SECRET = "not-a-real-value-" + "qa9f2c";
    const writes = [];
    const logs = [];
    const logger = {};
    for (const level of ["debug", "info", "warn", "error"]) logger[level] = (...args) => logs.push([level, ...args]);
    const store = {
      insert(row) {
        writes.push(row);
        return Promise.resolve({ id: "x", seq: writes.length, created_at: "2026-11-06T00:00:00.000Z" });
      },
    };
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store, logger });
    const attempts = [
      { type: "run.started", payload: { api_key: SECRET } },
      { type: "message.emitted", payload: { role: SECRET, summary: SECRET } },
      { type: "message.emitted", payload: { role: "agent", summary: "ok", token: SECRET } },
    ];
    for (const attemptInput of attempts) {
      const error = await emitter.emit(attemptInput).then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(RunEventValidationError);
      expect(JSON.stringify([error.message, error.issues])).not.toContain(SECRET);
    }
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    // A valid emit logs only the type and seq, never the payload.
    await emitter.emit({ type: "message.emitted", payload: { role: "agent", summary: "visible-summary-text" } });
    expect(JSON.stringify(logs)).not.toContain("visible-summary-text");
  });

  test("AC1: an unknown event type supplied by the caller is not echoed in the error message or issues", async () => {
    const SECRET = "not-a-real-value-" + "qa9f2c";
    const store = { insert: () => Promise.reject(new Error("must not be called")) };
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    const error = await emitter.emit({ type: SECRET, payload: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(RunEventValidationError);
    expect(JSON.stringify([error.message, error.issues])).not.toContain(SECRET);
  });

  test("AC2: a store failure surfaces as RunEventWriteError without the payload in its message", async () => {
    const store = { insert: () => Promise.reject(new Error("db down")) };
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    const error = await emitter.emit({ type: "message.emitted", payload: { role: "agent", summary: "private-text" } }).catch((e) => e);
    expect(error).toBeInstanceOf(RunEventWriteError);
    expect(error.message).not.toContain("private-text");
  });

  test("AC2: the emitter never sends a seq to the store (the database assigns it)", async () => {
    const rows = [];
    const store = {
      insert(row) {
        rows.push(row);
        return Promise.resolve({ id: "x", seq: rows.length, created_at: "2026-11-06T00:00:00.000Z" });
      },
    };
    const emitter = createRunEventEmitter({ workspaceId: WS, runId: RUN, store });
    await emitter.emit({ type: "step.started", payload: { step: 1 }, seq: 99 });
    expect(rows[0]).not.toHaveProperty("seq");
    expect(rows[0].payload).not.toHaveProperty("seq");
  });
});

describe("run event emitter against the local database", () => {
  const ws = { a: randomUUID(), b: randomUUID() };
  const user = { a: randomUUID(), b: randomUUID() };
  const agent = { a: randomUUID(), b: randomUUID() };
  const run = { one: randomUUID(), two: randomUUID(), clean: randomUUID(), foreign: randomUUID(), b: randomUUID() };
  let pool;
  let emitterFor;

  const seqs = async (runId) =>
    (await pool.query("select seq from public.run_events where run_id = $1 order by seq", [runId])).rows.map((r) => Number(r.seq));
  const count = async (runId) =>
    Number((await pool.query("select count(*) from public.run_events where run_id = $1", [runId])).rows[0].count);
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

  /** Run SQL as a signed-in user (RLS applies), in a transaction that is always rolled back. */
  async function asUser(userId, fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      return await fn(client);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }
  const attempt = (promise) =>
    promise.then(
      (r) => ({ ok: true, rowCount: r.rowCount }),
      (e) => ({ ok: false, code: e.code, message: String(e.message) }),
    );

  beforeAll(async () => {
    if (!dbUp) return;
    const pg = createRequire(new URL("../apps/worker/package.json", import.meta.url))("pg");
    pool = new pg.Pool({ connectionString: DB_URL, max: 25 });
    const store = createPgRunEventStore(pool);
    emitterFor = (workspaceId, runId) => createRunEventEmitter({ workspaceId, runId, store });
    const nil = "00000000-0000-0000-0000-000000000000";
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email) values
         ($1, $3, 'authenticated', 'authenticated', $4), ($2, $3, 'authenticated', 'authenticated', $5)`,
      [user.a, user.b, nil, `ago164qa-a-${user.a}@example.test`, `ago164qa-b-${user.b}@example.test`],
    );
    await pool.query(`insert into public.workspaces (id, name) values ($1, 'AGO-164 QA A'), ($2, 'AGO-164 QA B')`, [ws.a, ws.b]);
    await pool.query(
      `insert into public.members (workspace_id, user_id, role) values ($1, $3, 'viewer'), ($2, $4, 'viewer')`,
      [ws.a, ws.b, user.a, user.b],
    );
    await pool.query(`insert into public.agents (id, workspace_id, name) values ($1, $3, 'a'), ($2, $4, 'b')`, [agent.a, agent.b, ws.a, ws.b]);
    await pool.query(
      `insert into public.runs (id, workspace_id, agent_id) values
         ($1, $6, $7), ($2, $6, $7), ($3, $6, $7), ($4, $6, $7), ($5, $8, $9)`,
      [run.one, run.two, run.clean, run.foreign, run.b, ws.a, agent.a, ws.b, agent.b],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(teardownRunEventsSql([ws.a, ws.b]));
    await pool.query("delete from auth.users where id in ($1, $2)", [user.a, user.b]);
    await pool.end();
  });

  liveTest("AC2: 200 concurrent emits across 20+ connections give seq 1..200 with no gaps or duplicates", async () => {
    const emitter = emitterFor(ws.a, run.one);
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => emitter.emit({ type: "step.started", payload: { step: i + 1 } })),
    );
    expect(await seqs(run.one)).toEqual(range(200));
    const returned = results.map((r) => r.seq).sort((x, y) => x - y);
    expect(returned).toEqual(range(200));
    expect(new Set(results.map((r) => r.id)).size).toBe(200);
  });

  liveTest("AC2: two runs interleaved stay independent, each 1..N", async () => {
    const one = emitterFor(ws.a, run.two);
    const two = emitterFor(ws.a, run.clean);
    const jobs = [];
    for (let i = 0; i < 30; i += 1) {
      jobs.push(one.emit({ type: "budget.usage", payload: { input_tokens: i, output_tokens: 1 } }));
      if (i % 2 === 0) jobs.push(two.emit({ type: "step.started", payload: { step: i + 1 } }));
    }
    await Promise.all(jobs);
    expect(await seqs(run.two)).toEqual(range(30));
    expect(await seqs(run.clean)).toEqual(range(15));
  });

  liveTest("AC2: several emitters (workers) on the same run still produce a gap-free sequence", async () => {
    const before = await count(run.clean);
    const emitters = Array.from({ length: 5 }, () => emitterFor(ws.a, run.clean));
    await Promise.all(
      emitters.flatMap((e, i) => Array.from({ length: 8 }, () => e.emit({ type: "tool_call.started", payload: { call_id: `c${i}` } }))),
    );
    expect(await seqs(run.clean)).toEqual(range(before + 40));
  });

  liveTest("AC2: an invalid emit does not burn a seq number (the next valid emit continues at max+1)", async () => {
    const emitter = emitterFor(ws.a, run.foreign);
    await emitter.emit({ type: "run.started", payload: {} });
    await emitter.emit({ type: "step.started", payload: { step: 1 } });
    await expect(emitter.emit({ type: "step.started", payload: { step: -1 } })).rejects.toBeInstanceOf(RunEventValidationError);
    await expect(emitter.emit({ type: "unknown.type", payload: {} })).rejects.toBeInstanceOf(RunEventValidationError);
    const next = await emitter.emit({ type: "step.completed", payload: { step: 1, outcome: "ok" } });
    expect(next.seq).toBe(3);
    expect(await seqs(run.foreign)).toEqual([1, 2, 3]);
  });

  liveTest("AC2: a write the database rejects (run of another workspace) does not burn a seq number either", async () => {
    // seq is max+1 computed in the insert trigger (no sequence object), so a rolled-back insert leaves no hole.
    const before = await seqs(run.foreign);
    await expect(emitterFor(ws.b, run.foreign).emit({ type: "run.started", payload: {} })).rejects.toBeInstanceOf(RunEventWriteError);
    expect(await seqs(run.foreign)).toEqual(before);
    const next = await emitterFor(ws.a, run.foreign).emit({ type: "message.emitted", payload: { role: "agent", summary: "after" } });
    expect(next.seq).toBe(before.length + 1);
  });

  liveTest("AC1: every one of the 24 event types is stored and parses back through its schema", async () => {
    const emitter = emitterFor(ws.b, run.b);
    for (const type of V1_LIST) await emitter.emit({ type, payload: VALID[type] });
    const rows = (await pool.query("select type, payload, seq from public.run_events where run_id = $1 order by seq", [run.b])).rows;
    expect(rows.map((r) => r.type)).toEqual(V1_LIST);
    expect(rows.map((r) => Number(r.seq))).toEqual(range(24));
    for (const row of rows) {
      const parsed = parseStoredRunEvent(row);
      expect(parsed, row.type).not.toBeNull();
      expect(parsed.payload).toEqual(VALID[row.type]);
      expect(row.payload.version).toBe(1);
    }
  });

  liveTest("AC1: rejected events write nothing (unknown type, extra field, oversized text, bad approval actor)", async () => {
    const before = await count(run.one);
    const emitter = emitterFor(ws.a, run.one);
    const bad = [
      { type: "nope", payload: {} },
      { type: "run.started", payload: { api_key: "sk-secret" } },
      { type: "message.emitted", payload: { role: "agent", summary: "x".repeat(5_000) } },
      { type: "approval.decided", payload: { ...VALID["approval.decided"], decided_by: "timeout" } },
    ];
    for (const event of bad) await expect(emitter.emit(event)).rejects.toBeInstanceOf(RunEventValidationError);
    expect(await count(run.one)).toBe(before);
  });

  liveTest("security: the emitter cannot write events for a run in another workspace", async () => {
    const before = await count(run.b);
    // run.b belongs to workspace B; claiming workspace A must be refused by the database.
    await expect(emitterFor(ws.a, run.b).emit({ type: "run.started", payload: {} })).rejects.toBeInstanceOf(RunEventWriteError);
    expect(await count(run.b)).toBe(before);
    // and a run id that does not exist at all
    await expect(emitterFor(ws.a, randomUUID()).emit({ type: "run.started", payload: {} })).rejects.toBeInstanceOf(RunEventWriteError);
  });

  liveTest("security: authenticated users cannot update, delete, truncate or insert run events through the API role", async () => {
    const [{ id }] = (await pool.query("select id from public.run_events where run_id = $1 limit 1", [run.one])).rows;
    const snapshot = (await pool.query("select id, seq, type, payload from public.run_events where run_id = $1 order by seq", [run.one])).rows;
    const outcomes = await asUser(user.a, async (client) => {
      const results = [];
      for (const [sql, params] of [
        ["update public.run_events set type = 'tampered' where id = $1", [id]],
        ["update public.run_events set payload = '{}'::jsonb where run_id = $1", [run.one]],
        ["delete from public.run_events where id = $1", [id]],
        ["truncate public.run_events", []],
        [
          "insert into public.run_events (workspace_id, run_id, type, payload) values ($1, $2, 'run.started', '{\"version\":1}')",
          [ws.a, run.one],
        ],
      ]) {
        await client.query("savepoint s");
        results.push(await attempt(client.query(sql, params)));
        await client.query("rollback to savepoint s");
      }
      return results;
    });
    for (const outcome of outcomes) expect(outcome.ok === false || outcome.rowCount === 0, JSON.stringify(outcome)).toBe(true);
    const after = (await pool.query("select id, seq, type, payload from public.run_events where run_id = $1 order by seq", [run.one])).rows;
    expect(after).toEqual(snapshot);
  });

  liveTest("security: even the table owner cannot rewrite or delete an event (append-only)", async () => {
    const [{ id }] = (await pool.query("select id from public.run_events where run_id = $1 limit 1", [run.one])).rows;
    const update = await attempt(pool.query("update public.run_events set type = 'tampered' where id = $1", [id]));
    expect(update.ok).toBe(false);
    expect(update.message).toMatch(/append-only/);
    const del = await attempt(pool.query("delete from public.run_events where id = $1", [id]));
    expect(del.ok).toBe(false);
    expect(del.message).toMatch(/append-only/);
  });

  liveTest("security: RLS isolation holds for reads (members read their workspace, other workspaces see zero rows)", async () => {
    const readCount = (userId, runId) =>
      asUser(userId, async (client) => (await client.query("select count(*)::int as n from public.run_events where run_id = $1", [runId])).rows[0].n);
    expect(await readCount(user.a, run.one)).toBe(200);
    expect(await readCount(user.b, run.one)).toBe(0);
    expect(await readCount(user.b, run.b)).toBe(24);
    expect(await readCount(user.a, run.b)).toBe(0);
  });
});
