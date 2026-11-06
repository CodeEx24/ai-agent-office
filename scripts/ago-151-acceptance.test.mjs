/**
 * AGO-151 acceptance tests (QA). One test per acceptance criterion plus negative and edge cases.
 * Run with `vitest run --config vitest.scripts.config.mjs scripts/ago-151-acceptance.test.mjs`
 * (also part of `pnpm test`). Build first: `pnpm --filter @ago/worker build`.
 *
 * AGO-151 is a non-UI ticket (worker + database), so these are integration tests against the REAL
 * built worker (`apps/worker/dist`) running as separate OS processes (`scripts/fixtures/ago-151-proc.mjs`)
 * against the shared local Supabase stack (127.0.0.1:44322). They prove what the in-process tests in
 * `apps/worker/src/queue/` cannot: races between several connections AND processes, the real HTTP
 * `/health`, the pgboss schema through PostgREST, secrets in real process output, and real SIGTERM.
 *
 * - Live cases skip (with a note) when no Postgres answers on the local port, so CI without Docker stays green.
 * - Run them inside the lock:  node scripts/db-lock.mjs acquire AGO-151-qa ... release AGO-151-qa
 * - They use the global `agent-run` queue: every spawned process is stopped in afterEach and the queue's
 *   jobs are purged before each test, so nothing leaks between cases.
 * - No `.env*` file is read; every child gets an explicit environment. The SIGTERM cases need a Linux
 *   container (Windows cannot deliver SIGTERM to a node process), so they use the AGO-143 worker image.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_ENTRY = join(ROOT, "apps", "worker", "dist", "index.js");
const FIXTURE = join(ROOT, "scripts", "fixtures", "ago-151-proc.mjs");
const MIGRATION = "20261107010001_ago_151_pgboss_schema";
const IMAGE = "ago-worker-qa-151";

if (!existsSync(WORKER_ENTRY)) {
  throw new Error("apps/worker/dist is missing: run `pnpm --filter @ago/worker build` first");
}
const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
const pg = requireFromWorker("pg");

const LOCAL_DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const LOCAL_DB = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`;
const RUN_QUEUE = "agent-run";
const DEAD_QUEUE = "agent-run-dead";

/** Secret-shaped values built at runtime (no literal in the source for secret scanners). */
const SECRET_CORE = `Zk${"9q".repeat(10)}`;
const PW_CORE = `Pw${"7x".repeat(6)}`;
const FAIL_MESSAGE = `tool exploded: Authorization: Bearer ${SECRET_CORE} while calling postgres://worker:${PW_CORE}@db.internal.test:5432/app`;
const FORBIDDEN = [SECRET_CORE, PW_CORE];

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
const dbUp = await isPortOpen(LOCAL_DB_PORT);
const liveDescribe = describe.skipIf(!dbUp);
if (!dbUp) {
  console.warn(`AGO-151 live cases skipped: no Postgres at 127.0.0.1:${LOCAL_DB_PORT} (supabase start)`);
}
const dockerOk =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(read, { timeoutMs = 30_000, everyMs = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function cleanEnv(extra) {
  const base = {};
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  return { ...base, ...extra };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Every child we start, so afterEach can stop whatever a failed test left behind. */
const children = new Set();

function startProcess(args, env) {
  const child = spawn(process.execPath, args, {
    env: cleanEnv({ DATABASE_URL: LOCAL_DB, ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc = { child, stdout: "", stderr: "", exit: null };
  child.stdout.on("data", (chunk) => (proc.stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (proc.stderr += chunk.toString()));
  proc.exited = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      proc.exit = { code, signal };
      children.delete(proc);
      resolveExit(proc.exit);
    }),
  );
  proc.kill = async () => {
    if (proc.exit === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      await proc.exited;
    }
  };
  proc.output = () => proc.stdout + proc.stderr;
  children.add(proc);
  return proc;
}

/** The fixture: role consumer | enqueuer | worker. Resolves once it printed QA_READY (or exited). */
async function startFixture(role, env = {}) {
  const proc = startProcess([FIXTURE], { ROLE: role, ...env });
  if (role !== "enqueuer") {
    await waitFor(
      () => (proc.stdout.includes("QA_READY") ? true : proc.exit !== null ? proc.exit : undefined),
      { timeoutMs: 40_000, what: `${role} ready` },
    );
    if (proc.exit !== null) assert.fail(`${role} exited early:\n${proc.output()}`);
  }
  return proc;
}

async function runEnqueuers(count, jobsFor, extraEnv = {}) {
  const startAt = Date.now() + 5_000 + count * 400; // barrier: all processes enqueue at the same instant
  const procs = Array.from({ length: count }, (_, i) =>
    startProcess([FIXTURE], {
      ROLE: "enqueuer",
      ENQUEUE_AT: String(startAt),
      ENQUEUE_JOBS: JSON.stringify(jobsFor(i)),
      ...extraEnv,
    }),
  );
  await Promise.all(procs.map((p) => waitFor(() => p.exit, { timeoutMs: 90_000, what: "enqueuer exit" })));
  return procs.map((proc) => {
    const line = proc.stdout.split(/\r?\n/).find((l) => l.startsWith("QA_RESULT "));
    assert.ok(line, `enqueuer printed no result:\n${proc.output()}`);
    return JSON.parse(line.slice("QA_RESULT ".length));
  });
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
const execLog = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

async function healthOf(port, path = "/health") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

liveDescribe("AGO-151 pg-boss job queue (live database, real processes)", () => {
  let pool;
  let tmp;
  const workspaces = [];
  let seq = 0;

  const query = (sql, params) => pool.query(sql, params);

  async function newWorkspace() {
    const workspace = randomUUID();
    const agent = randomUUID();
    await query("insert into public.workspaces (id, name) values ($1, $2)", [workspace, `AGO-151 QA ${workspace.slice(0, 8)}`]);
    await query("insert into public.agents (id, workspace_id, name) values ($1, $2, 'qa-agent')", [agent, workspace]);
    workspaces.push(workspace);
    return { workspace, agent };
  }
  async function newRun({ workspace, agent }, status = "queued") {
    const id = randomUUID();
    await query("insert into public.runs (id, workspace_id, agent_id, status) values ($1, $2, $3, $4)", [id, workspace, agent, status]);
    return id;
  }
  const runStatus = async (id) =>
    (await query("select status from public.runs where id = $1", [id])).rows[0]?.status ?? "missing";
  const eventTypes = async (runId) =>
    (await query("select type from public.run_events where run_id = $1 order by seq", [runId])).rows.map((r) => r.type);
  const tmpFile = (name) => join(tmp, `${++seq}-${name}`);
  const purgeJobs = () => query("delete from pgboss.job where name = any($1)", [[RUN_QUEUE, DEAD_QUEUE]]).catch(() => undefined);
  const jobsFor = async (runId) =>
    (await query("select * from pgboss.job where name = $1 and data->>'run_id' = $2", [RUN_QUEUE, runId])).rows;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ago-151-qa-"));
    pool = new pg.Pool({ connectionString: LOCAL_DB, max: 3 });
    pool.on("error", () => undefined);
    // Make sure pg-boss's own tables exist (it installs them at first start) and the queue starts empty.
    await runEnqueuers(1, () => []);
    await purgeJobs();
  }, 120_000);

  beforeEach(async () => {
    await purgeJobs();
  });

  afterEach(async () => {
    await Promise.all([...children].map((proc) => proc.kill()));
    await sleep(200);
  });

  afterAll(async () => {
    await Promise.all([...children].map((proc) => proc.kill()));
    await purgeJobs();
    // run_events is append-only and its parents are RESTRICT: clean up like scripts/run-events-teardown.mjs.
    const ids = workspaces.map((id) => `'${id}'`).join(",");
    if (ids !== "") {
      await query(`
        begin;
        alter table public.run_events disable trigger run_events_block_update_delete;
        delete from public.run_events where workspace_id in (${ids});
        alter table public.run_events enable always trigger run_events_block_update_delete;
        delete from public.runs where workspace_id in (${ids});
        delete from public.workspaces where id in (${ids});
        commit;`);
    }
    await pool.end();
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  // ---------------------------------------------------------------------------------------------
  // AC1: Given a duplicate enqueue, when processed, then only one run executes.
  // ---------------------------------------------------------------------------------------------
  describe("AC1: duplicate enqueue executes once", () => {
    test("AC1: the same run enqueued concurrently from 6 separate processes becomes ONE job and ONE execution", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const results = await runEnqueuers(6, () => [{ workspaceId: ctx.workspace, runId }]);

      const all = results.flat();
      expect(all).toHaveLength(6);
      expect(all.every((r) => r.ok)).toBe(true);
      expect(all.filter((r) => r.enqueued)).toHaveLength(1); // exactly one new job
      expect(all.filter((r) => !r.enqueued && r.jobId === null)).toHaveLength(5);

      const jobs = await jobsFor(runId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].singleton_key).toBe(`${ctx.workspace}:run:${runId}`);
      expect(await eventTypes(runId)).toEqual(["run.created"]); // duplicates log no extra run.created

      // Two consumer processes race for that job.
      const log = tmpFile("exec.log");
      const env = { QA_EXEC_LOG: log, QA_EXEC_MS: "400" };
      await Promise.all([startFixture("consumer", env), startFixture("consumer", env)]);
      await waitFor(async () => (await runStatus(runId)) === "succeeded", { what: "run succeeded" });
      await sleep(2_500); // time for any stray second execution to show up

      expect(execLog(log).filter((e) => e.event === "start")).toHaveLength(1);
      expect(await eventTypes(runId)).toEqual(["run.created", "run.started", "run.completed"]);
      expect((await jobsFor(runId))[0].state).toBe("completed");
    }, 120_000);

    test("AC1: 8 different idempotency keys for one run, spread over 4 processes and 2 consumers, execute it exactly once", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const results = await runEnqueuers(4, (i) => [
        { workspaceId: ctx.workspace, runId, idempotencyKey: `qa-${i}-a` },
        { workspaceId: ctx.workspace, runId, idempotencyKey: `qa-${i}-b` },
      ]);
      expect(results.flat().every((r) => r.ok && r.enqueued)).toBe(true); // distinct keys pass the queue dedupe
      expect(await jobsFor(runId)).toHaveLength(8);

      const log = tmpFile("exec.log");
      const env = { QA_EXEC_LOG: log, QA_EXEC_MS: "400" };
      await Promise.all([startFixture("consumer", env), startFixture("consumer", env)]);
      await waitFor(async () => (await runStatus(runId)) === "succeeded", { what: "run succeeded" });
      await waitFor(
        async () => (await jobsFor(runId)).every((j) => j.state === "completed"),
        { timeoutMs: 40_000, what: "all 8 jobs completed (the 7 duplicates skipped, none stuck or failed)" },
      );

      expect(execLog(log).filter((e) => e.event === "start")).toHaveLength(1); // the database claim is the guard
      const types = await eventTypes(runId);
      expect(types.filter((t) => t === "run.started")).toHaveLength(1);
      expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
    }, 150_000);

    test("AC1 (tenancy): the same idempotency key in two workspaces does not collide", async () => {
      const a = await newWorkspace();
      const b = await newWorkspace();
      const runA = await newRun(a);
      const runB = await newRun(b);
      const [results] = await runEnqueuers(1, () => [
        { workspaceId: a.workspace, runId: runA, idempotencyKey: "shared-key" },
        { workspaceId: b.workspace, runId: runB, idempotencyKey: "shared-key" },
      ]);
      expect(results.map((r) => r.enqueued)).toEqual([true, true]);
      expect((await jobsFor(runA))[0].singleton_key).toBe(`${a.workspace}:key:shared-key`);
      expect((await jobsFor(runB))[0].singleton_key).toBe(`${b.workspace}:key:shared-key`);
    }, 90_000);

    test("AC1 (negative): another workspace's run, a non-queued run, a missing run and bad input are all refused and queue nothing", async () => {
      const mine = await newWorkspace();
      const other = await newWorkspace();
      const runId = await newRun(mine);
      const finished = await newRun(mine, "succeeded");
      const [results] = await runEnqueuers(1, () => [
        { workspaceId: other.workspace, runId }, // cross-workspace
        { workspaceId: mine.workspace, runId: finished }, // not queued
        { workspaceId: mine.workspace, runId: randomUUID() }, // missing
        { workspaceId: "not-a-uuid", runId }, // bad id
        { workspaceId: mine.workspace, runId, idempotencyKey: "" }, // empty key
        { workspaceId: mine.workspace, runId, idempotencyKey: "has space!" }, // bad characters
        { workspaceId: mine.workspace, runId, idempotencyKey: "k".repeat(201) }, // too long
      ]);
      expect(results.every((r) => r.ok === false)).toBe(true);
      expect(results.slice(0, 3).map((r) => r.error)).toEqual(["RunNotQueueableError", "RunNotQueueableError", "RunNotQueueableError"]);
      expect(results.slice(3).map((r) => r.error)).toEqual(["ZodError", "ZodError", "ZodError", "ZodError"]);
      const jobs = await query("select count(*)::int as n from pgboss.job where name = $1", [RUN_QUEUE]);
      expect(jobs.rows[0].n).toBe(0);
      expect(await eventTypes(runId)).toEqual([]); // nothing was written for the refused enqueues
    }, 90_000);

    test("AC1 (security): a job carries ids only, never a prompt, credential or run content", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId, idempotencyKey: "ids-only" }]);
      const [job] = await jobsFor(runId);
      expect(Object.keys(job.data).sort()).toEqual(["run_id", "workspace_id"]);
      expect(job.data).toEqual({ workspace_id: ctx.workspace, run_id: runId });
    }, 90_000);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2: Failed jobs retry with backoff up to a limit (then dead-letter, visible, never forever).
  // ---------------------------------------------------------------------------------------------
  describe("AC2: retry with backoff, then dead letter", () => {
    test("AC2: a job that throws retries with growing delays up to the cap, then dead-letters, visibly and only once", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const log = tmpFile("exec.log");
      const sentry = tmpFile("sentry.log");
      // retryLimit 4 => 5 attempts. Delay base 1 s, cap 6 s. pg-boss: delay = min(cap, base * 2^e/2 * (1 + rand)).
      const policy = { QA_RETRY_LIMIT: "4", QA_RETRY_DELAY: "1", QA_RETRY_MAX: "6", QA_EXPIRE: "60" };
      const consumer = await startFixture("consumer", {
        ...policy,
        QA_EXEC_LOG: log,
        QA_SENTRY_FILE: sentry,
        QA_FAIL_MESSAGE: FAIL_MESSAGE,
      });
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId }], policy);

      await waitFor(async () => (await runStatus(runId)) === "failed", { timeoutMs: 60_000, what: "run failed" });
      const starts = execLog(log).filter((e) => e.event === "start");
      expect(starts.map((e) => e.attempt)).toEqual([0, 1, 2, 3, 4]); // first attempt + exactly retryLimit retries

      // Backoff: every gap sits above the lower envelope min(2^(k-1), cap) and below the cap plus one poll cycle,
      // and the gaps grow until they hit the cap.
      const gaps = starts.slice(1).map((e, i) => (e.at - starts[i].at) / 1000);
      const cap = 6;
      gaps.forEach((gap, i) => {
        const lower = Math.min(2 ** i, cap);
        expect(gap, `gap ${i + 1} (${gap}s) should be >= ${lower}s`).toBeGreaterThanOrEqual(lower - 0.2);
        expect(gap, `gap ${i + 1} (${gap}s) should be <= cap ${cap}s + a poll`).toBeLessThanOrEqual(cap + 1.5);
      });
      expect(gaps[3]).toBeGreaterThan(gaps[0]); // growing, not constant

      // Dead letter: one copy in agent-run-dead, ids only, and the original job is failed, not retried again.
      const dead = await waitFor(
        async () => {
          const rows = (await query("select data, state from pgboss.job where name = $1", [DEAD_QUEUE])).rows;
          return rows.length > 0 ? rows : undefined;
        },
        { what: "dead-letter row" },
      );
      expect(dead).toHaveLength(1);
      expect(Object.keys(dead[0].data).sort()).toEqual(["run_id", "workspace_id"]);
      expect(dead[0].data.run_id).toBe(runId);
      const [original] = await jobsFor(runId);
      expect(original.state).toBe("failed");
      expect(original.retry_count).toBe(4);

      // Not retried forever: wait longer than the cap and see that nothing else runs.
      await sleep((cap + 3) * 1000);
      expect(execLog(log).filter((e) => e.event === "start")).toHaveLength(5);
      expect((await jobsFor(runId))[0].state).toBe("failed");

      // run_events: failed after the last attempt, with a scrubbed, bounded message.
      const failed = (await query("select payload from public.run_events where run_id = $1 and type = 'run.failed'", [runId])).rows;
      expect(failed).toHaveLength(1);
      expect(failed[0].payload.reason).toBe("retries_exhausted");
      expect(String(failed[0].payload.message).length).toBeLessThanOrEqual(300);
      expect(JSON.stringify(failed[0].payload)).not.toContain(SECRET_CORE);
      expect(JSON.stringify(failed[0].payload)).not.toContain(PW_CORE);

      // Logs and Sentry: run_id on the failure lines, no secret anywhere.
      await consumer.kill();
      const lines = parseJsonLines(consumer.stdout);
      const failureLines = lines.filter((l) => /will retry|failed after all retries/.test(l.msg ?? ""));
      expect(failureLines.length).toBeGreaterThanOrEqual(5);
      for (const l of failureLines) {
        expect(l.run_id).toBe(runId);
        expect(l.workspace_id).toBe(ctx.workspace);
      }
      const sentryText = existsSync(sentry) ? readFileSync(sentry, "utf8") : "";
      expect(sentryText).toContain(runId); // Sentry carries the run id
      for (const secret of FORBIDDEN) {
        expect(consumer.output(), "process output").not.toContain(secret);
        expect(sentryText, "sentry events").not.toContain(secret);
      }
    }, 150_000);

    test("AC2 (edge): a job that fails once and then succeeds ends the run succeeded with a single completion", async () => {
      // QA_FAIL_MESSAGE fails every attempt, so use two consumer lifetimes: fail first, then a healthy consumer finishes it.
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const log = tmpFile("exec.log");
      const policy = { QA_RETRY_LIMIT: "3", QA_RETRY_DELAY: "1", QA_RETRY_MAX: "2", QA_EXPIRE: "60", QA_EXEC_LOG: log };
      const failing = await startFixture("consumer", { ...policy, QA_FAIL_MESSAGE: "transient glitch" });
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId }], policy);
      await waitFor(() => execLog(log).some((e) => e.event === "start"), { what: "first attempt" });
      await failing.kill();
      await startFixture("consumer", { ...policy, QA_EXEC_MS: "100" });
      await waitFor(async () => (await runStatus(runId)) === "succeeded", { timeoutMs: 60_000, what: "run succeeded after a retry" });
      const types = await eventTypes(runId);
      expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
      expect(types).not.toContain("run.failed");
      expect(execLog(log).filter((e) => e.event === "done")).toHaveLength(1);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------------------------
  // AC3: Queue depth is exposed to health.
  // ---------------------------------------------------------------------------------------------
  describe("AC3: queue depth in /health", () => {
    test("AC3: /health shows live queue depth that rises as jobs are added (no consumer), not a stale cache", async () => {
      const ctx = await newWorkspace();
      const port = await freePort();
      const worker = await startFixture("worker", { WORKER_PORT: String(port), QA_NO_EXECUTOR: "1" });
      const ready = await waitFor(async () => {
        const h = await healthOf(port).catch(() => null);
        return h?.body.queue?.status === "ok" ? h : undefined;
      }, { what: "queue ok in /health" });
      expect(ready.status).toBe(200);
      expect(ready.body.status).toBe("ok");
      expect(ready.body.queue.depth).toEqual({ queued: 0, active: 0, failed: 0, dead_letter: 0 });

      const first = [await newRun(ctx), await newRun(ctx), await newRun(ctx)];
      await runEnqueuers(1, () => first.map((runId) => ({ workspaceId: ctx.workspace, runId })));
      expect((await healthOf(port)).body.queue.depth.queued).toBe(3); // immediately, no waiting for a refresh

      const second = [await newRun(ctx), await newRun(ctx)];
      await runEnqueuers(1, () => second.map((runId) => ({ workspaceId: ctx.workspace, runId })));
      const after = await healthOf(port);
      expect(after.body.queue.depth).toEqual({ queued: 5, active: 0, failed: 0, dead_letter: 0 });
      expect((await healthOf(port, "/healthz")).body.queue.depth.queued).toBe(5);

      // Depth is counts only: no run, workspace or payload data leaks through the probe.
      const text = JSON.stringify(after.body);
      for (const id of [...first, ...second, ctx.workspace]) expect(text).not.toContain(id);
      expect(worker.exit).toBeNull();
    }, 120_000);

    test("AC3: depth changes as jobs are processed: queued falls, active rises, then everything drains to zero", async () => {
      const ctx = await newWorkspace();
      const port = await freePort();
      await startFixture("worker", { WORKER_PORT: String(port), QUEUE_CONCURRENCY: "1", QA_EXEC_MS: "2500" });
      await waitFor(async () => (await healthOf(port).catch(() => null))?.body.queue?.status === "ok", { what: "queue ok" });
      const runs = [await newRun(ctx), await newRun(ctx), await newRun(ctx)];
      await runEnqueuers(1, () => runs.map((runId) => ({ workspaceId: ctx.workspace, runId })));

      let sawQueued = false;
      let sawActive = false;
      let sawBoth = false;
      let maxActive = 0;
      await waitFor(
        async () => {
          const { depth } = (await healthOf(port)).body.queue;
          sawQueued ||= depth.queued > 0;
          sawActive ||= depth.active > 0;
          sawBoth ||= depth.queued > 0 && depth.active > 0;
          maxActive = Math.max(maxActive, depth.active);
          return depth.queued === 0 && depth.active === 0 && sawActive ? depth : undefined;
        },
        { timeoutMs: 60_000, everyMs: 150, what: "queue to drain" },
      );
      expect(sawQueued).toBe(true);
      expect(sawActive).toBe(true);
      expect(sawBoth).toBe(true); // while one job is active the others are still waiting
      expect(maxActive).toBe(1); // QUEUE_CONCURRENCY=1 is honoured
      for (const runId of runs) expect(await runStatus(runId)).toBe("succeeded");
    }, 120_000);

    test("AC3: a failed-out job shows in /health as dead_letter and is not counted as queued forever", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const port = await freePort();
      const policy = { QA_RETRY_LIMIT: "1", QA_RETRY_DELAY: "1", QA_RETRY_MAX: "2", QA_EXPIRE: "60" };
      // The worker role uses the built-in retry policy (5 s base), so a consumer does the failing and a
      // second, executor-less worker only serves the probe.
      await startFixture("consumer", { ...policy, QA_FAIL_MESSAGE: "always broken" });
      await startFixture("worker", { WORKER_PORT: String(port), QA_NO_EXECUTOR: "1" });
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId }], policy);
      const depth = await waitFor(async () => {
        const h = await healthOf(port).catch(() => null);
        return h?.body.queue?.depth?.dead_letter === 1 ? h.body.queue.depth : undefined;
      }, { timeoutMs: 60_000, what: "dead_letter = 1 in /health" });
      expect(depth.queued).toBe(0);
      expect(depth.active).toBe(0);
    }, 120_000);

    test("AC3 (negative): database down -> /health and /healthz answer 503 with status down, the process stays up", async () => {
      const port = await freePort();
      const closedPort = await freePort(); // nothing listens here
      const worker = startProcess([WORKER_ENTRY], {
        WORKER_PORT: String(port),
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${closedPort}/postgres`,
      });
      await waitFor(() => worker.stdout.includes("worker started"), { timeoutMs: 20_000, what: "worker started" });
      for (const path of ["/health", "/healthz"]) {
        const h = await healthOf(port, path);
        expect(h.status).toBe(503);
        expect(h.body.status).toBe("down");
        expect(h.body.db.status).toBe("down");
        expect(h.body.queue.status).toBe("down");
        expect(h.body.queue.depth).toBeUndefined();
      }
      expect(worker.exit).toBeNull(); // no crash loop while the database is away
      expect(worker.output()).not.toContain("postgres:postgres"); // credentials never in logs
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------
  // Security: the pgboss schema is not reachable by the API roles or through PostgREST.
  // ---------------------------------------------------------------------------------------------
  describe("security: pgboss schema is locked down", () => {
    const roles = ["anon", "authenticated", "service_role"];

    test("no API role holds any privilege on a pgboss table, sequence or the schema (checked after pg-boss installed its tables)", async () => {
      const tables = (await query(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'pgboss' and c.relkind in ('r','p','v','m')`,
      )).rows[0].n;
      expect(tables).toBeGreaterThan(0); // pg-boss really installed its tables, so the check is not vacuous
      for (const role of roles) {
        const t = await query(
          `select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
             cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
            where n.nspname = 'pgboss' and c.relkind in ('r','p','v','m') and has_table_privilege($1, c.oid, p.priv)`,
          [role],
        );
        expect(t.rows, `${role} table privileges`).toEqual([]);
        const s = await query(
          `select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
             cross join unnest(array['USAGE','SELECT','UPDATE']) as p(priv)
            where n.nspname = 'pgboss' and c.relkind = 'S' and has_sequence_privilege($1, c.oid, p.priv)`,
          [role],
        );
        expect(s.rows, `${role} sequence privileges`).toEqual([]);
        const schema = (await query(
          "select has_schema_privilege($1, 'pgboss', 'USAGE') as usage, has_schema_privilege($1, 'pgboss', 'CREATE') as ccreate",
          [role],
        )).rows[0];
        expect(schema, `${role} schema privileges`).toEqual({ usage: false, ccreate: false });
      }
    });

    test("selecting from pgboss.job as anon, authenticated or service_role is denied by Postgres", async () => {
      for (const role of roles) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await expect(client.query("select count(*) from pgboss.job")).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      }
    });

    test("calling a pgboss function as anon, authenticated or service_role is denied by Postgres (no schema USAGE)", async () => {
      for (const role of roles) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await expect(client.query("select pgboss.job_now()")).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      }
    });

    // FINDING (AGO-151 QA): pg-boss creates its functions at runtime and Postgres grants EXECUTE on new functions to
    // PUBLIC, so once the worker has installed pg-boss, anon/authenticated/service_role hold EXECUTE on 6 pgboss
    // functions (the pgTAP test supabase/tests/pgboss_isolation.test.sql test 7 fails for the same reason). Calls are
    // still denied only because the roles lack schema USAGE. Defence in depth wants the grant itself gone, e.g.
    // `alter default privileges for role <worker owner> in schema pgboss revoke execute on functions from public`.
    test("no API role holds EXECUTE on any pgboss function once pg-boss is installed (defence in depth)", async () => {
      for (const role of roles) {
        const executable = await query(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pgboss' and has_function_privilege($1, p.oid, 'EXECUTE') order by 1`,
          [role],
        );
        expect(executable.rows.map((r) => r.proname), `${role} EXECUTE on pgboss functions`).toEqual([]);
      }
    });

    test("PostgREST refuses the pgboss schema for anon, authenticated and service_role tokens (read, write, rpc)", async () => {
      const status = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "json"], { cwd: ROOT, encoding: "utf8", shell: true });
      assert.equal(status.status, 0, "supabase status failed");
      const info = JSON.parse(status.stdout.slice(status.stdout.indexOf("{")));
      const api = info.REST_URL;
      expect(api).toMatch(/^http:\/\/127\.0\.0\.1:/); // the local stack only
      const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const sign = (claims) => {
        const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ ...claims, iss: "supabase-demo", exp: Math.floor(Date.now() / 1000) + 600 })}`;
        return `${head}.${createHmac("sha256", info.JWT_SECRET).update(head).digest("base64url")}`;
      };
      const tokens = {
        anon: info.ANON_KEY,
        authenticated: sign({ role: "authenticated", sub: randomUUID(), aud: "authenticated" }),
        service_role: sign({ role: "service_role" }),
      };
      // Sanity: the same tokens DO work against the exposed public schema, so a refusal is about the schema.
      const sane = await fetch(`${api}/workspaces?select=id&limit=1`, { headers: { apikey: info.ANON_KEY, Authorization: `Bearer ${tokens.service_role}` } });
      expect(sane.status).toBe(200);
      for (const [role, token] of Object.entries(tokens)) {
        const headers = { apikey: info.ANON_KEY, Authorization: `Bearer ${token}` };
        const read = await fetch(`${api}/job?select=*`, { headers: { ...headers, "Accept-Profile": "pgboss" } });
        const write = await fetch(`${api}/job`, {
          method: "POST",
          headers: { ...headers, "Content-Profile": "pgboss", "Content-Type": "application/json" },
          body: JSON.stringify({ name: RUN_QUEUE, data: {} }),
        });
        const rpc = await fetch(`${api}/rpc/create_queue`, {
          method: "POST",
          headers: { ...headers, "Content-Profile": "pgboss", "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        for (const [what, response] of [["read", read], ["write", write], ["rpc", rpc]]) {
          const body = await response.json();
          expect(response.status, `${role} ${what}`).toBe(406);
          expect(body.code, `${role} ${what}`).toBe("PGRST106");
        }
        // Not reachable by guessing the table in the exposed schema either.
        expect((await fetch(`${api}/job?select=*`, { headers })).status).toBe(404);
      }
    }, 90_000);

    test("the migration revokes everything from the API roles and the rollback only drops the schema", () => {
      const up = readFileSync(join(ROOT, "supabase", "migrations", `${MIGRATION}.sql`), "utf8").toLowerCase();
      const down = readFileSync(join(ROOT, "supabase", "rollbacks", `${MIGRATION}.down.sql`), "utf8").toLowerCase();
      expect(up).toMatch(/revoke all on schema pgboss from[^;]*anon[^;]*authenticated[^;]*service_role/s);
      expect(up).not.toMatch(/grant [^;]*pgboss/);
      expect(down).toContain("drop schema if exists pgboss cascade");
      expect(down).not.toMatch(/drop (table|schema) [^;]*public/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Graceful shutdown: SIGTERM drains or aborts within the timeout without losing or double-running jobs.
  // ---------------------------------------------------------------------------------------------
  const dockerDescribe = describe.skipIf(!dockerOk);
  dockerDescribe("graceful shutdown (real SIGTERM delivered by `docker stop` to the worker image)", () => {
    let name = "";
    const fixtureDir = join(ROOT, "scripts", "fixtures");

    beforeAll(() => {
      const have = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
      if (!have) {
        const build = spawnSync("docker", ["build", "-f", "apps/worker/Dockerfile", "-t", IMAGE, "."], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        assert.equal(build.status, 0, `docker build failed:\n${build.stderr?.slice(-2000)}`);
      }
    }, 900_000);

    afterEach(() => {
      if (name) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      name = "";
    });

    function runContainer(env, logFile) {
      name = `ago151-qa-${randomUUID().slice(0, 8)}`;
      const logDir = dirname(logFile);
      const args = [
        "run", "-d", "--name", name,
        "--add-host", "host.docker.internal:host-gateway",
        "-v", `${fixtureDir}:/fix:ro`,
        "-v", `${logDir}:/out`,
        "-e", "AGO_WORKER_DIST=/app/dist/",
        "-e", `DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:${LOCAL_DB_PORT}/postgres`,
        "-e", `QA_EXEC_LOG=/out/${logFile.split(/[\\/]/).pop()}`,
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        IMAGE, "node", "/fix/ago-151-proc.mjs",
      ];
      const started = spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
      assert.equal(started.status, 0, started.stderr);
      return name;
    }
    const containerLogs = () => spawnSync("docker", ["logs", name], { encoding: "utf8" });
    const exitCode = () => Number(spawnSync("docker", ["inspect", "-f", "{{.State.ExitCode}}", name], { encoding: "utf8" }).stdout.trim());

    test("SIGTERM while a job is running: the worker drains it, finishes the run once and exits 0 inside the timeout", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const log = tmpFile("drain.log");
      runContainer({ ROLE: "consumer", QA_EXEC_MS: "4000", QUEUE_SHUTDOWN_TIMEOUT_MS: "20000" }, log);
      await waitFor(() => containerLogs().stdout.includes("QA_READY"), { timeoutMs: 40_000, what: "container ready" });
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId }]);
      await waitFor(() => execLog(log).some((e) => e.event === "start"), { timeoutMs: 30_000, what: "job started in the container" });

      const t0 = Date.now();
      const stop = spawnSync("docker", ["stop", "-t", "40", name], { encoding: "utf8" });
      const took = Date.now() - t0;
      expect(stop.status).toBe(0);
      expect(exitCode(), containerLogs().stdout).toBe(0); // a clean exit, not a kill (137)
      expect(took).toBeLessThan(20_000); // inside QUEUE_SHUTDOWN_TIMEOUT_MS
      expect(containerLogs().stdout).toContain('"signal":"SIGTERM"');
      // The running job was drained, not lost and not duplicated.
      expect(await runStatus(runId)).toBe("succeeded");
      expect(execLog(log).filter((e) => e.event === "start")).toHaveLength(1);
      expect(execLog(log).filter((e) => e.event === "done")).toHaveLength(1);
      expect(await eventTypes(runId)).toEqual(["run.created", "run.started", "run.completed"]);
      expect((await jobsFor(runId))[0].state).toBe("completed");
    }, 180_000);

    test("SIGTERM past the drain timeout: the job is aborted on time, the run is handed back and the next worker finishes it exactly once", async () => {
      const ctx = await newWorkspace();
      const runId = await newRun(ctx);
      const log = tmpFile("abort.log");
      const policy = { QA_RETRY_LIMIT: "3", QA_RETRY_DELAY: "1", QA_RETRY_MAX: "2", QA_EXPIRE: "60" };
      runContainer({ ROLE: "consumer", QA_HANG: "1", QUEUE_SHUTDOWN_TIMEOUT_MS: "3000", ...policy }, log);
      await waitFor(() => containerLogs().stdout.includes("QA_READY"), { timeoutMs: 40_000, what: "container ready" });
      await runEnqueuers(1, () => [{ workspaceId: ctx.workspace, runId }], policy);
      await waitFor(() => execLog(log).some((e) => e.event === "start"), { timeoutMs: 30_000, what: "job started" });

      const t0 = Date.now();
      spawnSync("docker", ["stop", "-t", "40", name], { encoding: "utf8" });
      const took = Date.now() - t0;
      expect(took).toBeLessThan(15_000); // ~3 s timeout, not the 40 s kill grace
      expect(exitCode(), containerLogs().stdout).not.toBe(137);
      expect(execLog(log).some((e) => e.event === "aborted")).toBe(true); // the job saw the abort signal
      expect(await eventTypes(runId)).not.toContain("run.completed");

      // The next worker picks the retried job up and completes it; nothing ran twice to completion.
      await startFixture("consumer", { ...policy, QA_EXEC_LOG: log, QA_EXEC_MS: "100" });
      await waitFor(async () => (await runStatus(runId)) === "succeeded", { timeoutMs: 60_000, what: "run succeeded on the next worker" });
      const entries = execLog(log);
      expect(entries.filter((e) => e.event === "done")).toHaveLength(1);
      const types = await eventTypes(runId);
      expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
      expect(types).not.toContain("run.failed");
    }, 240_000);
  });
});

describe("AGO-151 offline checks (run everywhere, no database)", () => {
  test("the fixture exists and the worker entry handles SIGTERM and SIGINT", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const entry = readFileSync(join(ROOT, "apps", "worker", "src", "index.ts"), "utf8");
    expect(entry).toContain('process.once("SIGTERM"');
    expect(entry).toContain('process.once("SIGINT"');
  });

  test("an unreachable database never crashes the worker: it reports 503 and stays up", async () => {
    const port = await freePort();
    const closed = await freePort();
    const worker = startProcess([WORKER_ENTRY], {
      WORKER_PORT: String(port),
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${closed}/postgres`,
    });
    try {
      await waitFor(() => worker.stdout.includes("worker started"), { timeoutMs: 20_000, what: "worker started" });
      const h = await healthOf(port);
      expect(h.status).toBe(503);
      expect(h.body).toMatchObject({ status: "down", db: { status: "down" }, queue: { status: "down" } });
      await sleep(1_500);
      expect(worker.exit).toBeNull();
    } finally {
      await worker.kill();
    }
  }, 60_000);
});
