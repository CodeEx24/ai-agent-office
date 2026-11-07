/**
 * AGO-151 (QA, gate fix round 2): the pgboss hardening revoke must survive many workers starting at once.
 * Real built worker processes (scripts/fixtures/ago-151-proc.mjs, ROLE=worker) start behind a barrier against
 * the shared LOCAL stack; none may crash and afterwards PUBLIC/anon/authenticated/service_role hold no EXECUTE
 * on any pgboss function. The "re-grant" case puts EXECUTE back on PUBLIC first, so the revoke path itself
 * runs concurrently (the original `tuple concurrently updated` failure).
 * Run inside the lock: node scripts/db-lock.mjs acquire AGO-151-qa ... release AGO-151-qa
 * Build first: pnpm --filter @ago/worker build. Skips when no Postgres answers on the local port.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts", "fixtures", "ago-151-proc.mjs");
if (!existsSync(join(ROOT, "apps", "worker", "dist", "index.js"))) {
  throw new Error("apps/worker/dist is missing: run `pnpm --filter @ago/worker build` first");
}
const pg = createRequire(join(ROOT, "apps", "worker", "package.json"))("pg");
const PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const LOCAL_DB = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
// This file's own queue (AGO-202): its workers never touch the shared `agent-run` queue of other suites.
const QUEUE_NAME = `agent-run-ago151-cs-${randomUUID().slice(0, 8)}`;
const WORKERS = 10;
const ROUNDS = 3;

const dbUp = await new Promise((done) => {
  const socket = net.connect({ port: PORT, host: "127.0.0.1" });
  const finish = (open) => {
    socket.destroy();
    done(open);
  };
  socket.setTimeout(1_000, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((ok, fail) => {
    const server = net.createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });

const children = new Set();
function startWorker(env) {
  const base = {};
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...base, DATABASE_URL: LOCAL_DB, ROLE: "worker", QA_NO_EXECUTOR: "1", QA_QUEUE_NAME: QUEUE_NAME, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc = { child, out: "", exit: null };
  child.stdout.on("data", (c) => (proc.out += c));
  child.stderr.on("data", (c) => (proc.out += c));
  proc.exited = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      proc.exit = { code, signal };
      children.delete(proc);
      resolveExit(proc.exit);
    }),
  );
  children.add(proc);
  return proc;
}
async function killAll() {
  for (const proc of [...children]) {
    if (proc.exit === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.child.pid), "/T", "/F"], { stdio: "ignore" });
      else proc.child.kill("SIGKILL");
      await proc.exited;
    }
  }
}

async function startTogether(count) {
  const startAt = Date.now() + 4_000 + count * 300;
  const ports = await Promise.all(Array.from({ length: count }, freePort));
  const procs = ports.map((port) => startWorker({ WORKER_PORT: String(port), QA_START_AT: String(startAt) }));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && procs.some((p) => !p.out.includes("QA_READY") && p.exit === null)) await sleep(100);
  await sleep(1_000); // a crash after QA_READY (an unhandled rejection) would still show here
  return procs;
}

describe.skipIf(!dbUp)("AGO-151 pgboss hardening survives concurrent worker starts", () => {
  let pool;
  const grants = async () =>
    (
      await pool.query(`
        select p.proname, a.grantee = 0 as is_public, r.rolname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          left join pg_roles r on r.oid = a.grantee
         where n.nspname = 'pgboss' and a.privilege_type = 'EXECUTE'
           and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
         order by 1`)
    ).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: LOCAL_DB, max: 2 });
    pool.on("error", () => undefined);
    const first = startWorker({ WORKER_PORT: String(await freePort()) }); // makes sure pg-boss is installed
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !first.out.includes("QA_READY") && first.exit === null) await sleep(100);
    await killAll();
  }, 120_000);
  afterEach(killAll);
  afterAll(async () => {
    await killAll();
    // Remove this file's queues so unique names do not pile up in pgboss.queue run after run.
    for (const name of [QUEUE_NAME, `${QUEUE_NAME}-dead`]) {
      await pool.query("select pgboss.delete_queue($1)", [name]).catch(() => undefined);
    }
    await pool.end();
  });

  test(`${WORKERS} workers starting at the same instant, ${ROUNDS} times: all start, none crash, no PUBLIC/API-role EXECUTE after`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const procs = await startTogether(WORKERS);
      for (const proc of procs) {
        expect(proc.exit, `round ${round}: a worker exited:\n${proc.out}`).toBeNull();
        expect(proc.out, `round ${round}`).toContain("QA_READY");
        expect(proc.out).not.toMatch(/concurrently updated|unhandled/i);
      }
      expect(await grants(), `round ${round}: EXECUTE grants left`).toEqual([]);
      await killAll();
    }
  }, 240_000);

  test(`EXECUTE re-granted to PUBLIC, then ${WORKERS} workers start together, ${ROUNDS} times: the revoke runs concurrently and still wins`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      await pool.query("grant execute on all functions in schema pgboss to public");
      expect((await grants()).length, "precondition: the grant is really back").toBeGreaterThan(0);
      const procs = await startTogether(WORKERS);
      for (const proc of procs) {
        expect(proc.exit, `round ${round}: a worker exited:\n${proc.out}`).toBeNull();
        expect(proc.out, `round ${round}`).toContain("QA_READY");
        expect(proc.out).not.toMatch(/concurrently updated|unhandled/i);
      }
      expect(await grants(), `round ${round}: EXECUTE grants left`).toEqual([]);
      await killAll();
    }
  }, 240_000);
});
