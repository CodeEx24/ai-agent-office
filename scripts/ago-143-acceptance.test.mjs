/**
 * AGO-143 acceptance tests (QA). One test per acceptance criterion, plus negative and edge cases.
 * Run with `vitest run --config vitest.scripts.config.mjs scripts/ago-143-acceptance.test.mjs`
 * (also part of `pnpm test`).
 *
 * The worker is a non-UI service, so these are integration tests: they start the built worker
 * (`apps/worker/dist`) as a real child process against the local Supabase Postgres
 * (127.0.0.1:44322, read-only `select 1`) and drive it over HTTP. No `.env*` file is read or
 * written: every environment is passed on the child process command line. The Docker tests build
 * the real image and are skipped only where no Docker daemon is available.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_ENTRY = join(ROOT, "apps", "worker", "dist", "index.js");
const WORKFLOW = join(ROOT, ".github", "workflows", "worker-image.yml");
const DOCKERFILE = join(ROOT, "apps", "worker", "Dockerfile");

const LOCAL_DB_PORT = Number(process.env.AGO_TEST_DB_PORT ?? 44322);
const LOCAL_DB = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`;
/** A value that must never appear in any output. */
const SECRET = "qa-secret-value-7f3a9c1e5b2d";
const DB_PASSWORD = "qa-db-password-91ac";
const IMAGE = "ago-worker-qa-143";

if (!existsSync(WORKER_ENTRY)) {
  throw new Error("apps/worker/dist is missing: run `pnpm --filter @ago/worker build` first");
}
const LOGGER = await import(new URL("../apps/worker/dist/logger.js", import.meta.url).href);
const { createLogger, withContext, REDACTED } = LOGGER;

/** True when something accepts TCP connections on the local Supabase Postgres port (CI has none). */
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
/**
 * Cases that need a live database are skipped (with this reason) when the local stack is down, so CI
 * stays green; they always run locally with `supabase start`. Down-database, 404, no-leak, env,
 * logging and static checks run everywhere.
 */
const dbUp = await isPortOpen(LOCAL_DB_PORT);
const liveTest = test.skipIf(!dbUp);
const LIVE_DB_NOTE = `live-DB cases skipped: no Postgres at 127.0.0.1:${LOCAL_DB_PORT} (start with \`supabase start\`)`;
if (!dbUp) console.warn(LIVE_DB_NOTE);

/** Child-process env: only PATH-like basics plus what the test passes (never inherits secrets). */
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

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        assert.fail(`log line is not valid JSON: ${line}`);
      }
    });
}

/** Spawn the built worker. Resolves once it logs "worker started" (or rejects if it exits first). */
async function startWorker(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    env: cleanEnv({ WORKER_PORT: String(port), DATABASE_URL: LOCAL_DB, ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const worker = { child, port, stdout: "", stderr: "", exit: null, exited: null, url: null, stop: null };
  child.stdout.on("data", (chunk) => (worker.stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (worker.stderr += chunk.toString()));
  worker.exited = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      worker.exit = { code, signal };
      resolveExit(worker.exit);
    }),
  );
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker did not start:\n${worker.stdout}${worker.stderr}`)),
      15_000,
    );
    const poll = setInterval(() => {
      if (worker.stdout.includes("worker started")) {
        clearTimeout(timer);
        clearInterval(poll);
        resolveReady();
      }
    }, 50);
    worker.exited.then(() => {
      clearTimeout(timer);
      clearInterval(poll);
      if (!worker.stdout.includes("worker started")) {
        reject(new Error(`worker exited before starting:\n${worker.stdout}${worker.stderr}`));
      }
    });
  });
  worker.url = (path) => `http://127.0.0.1:${port}${path}`;
  worker.stop = async () => {
    if (worker.exit === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      await worker.exited;
    }
  };
  return worker;
}

/** Run the worker expecting it to exit by itself (bad env, port clash). */
function runToExit(extraEnv, timeoutMs = 15_000) {
  return spawnSync(process.execPath, [WORKER_ENTRY], {
    env: cleanEnv(extraEnv),
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

/** Logger writing to an in-memory collector, one parsed object per line. */
function collectingLogger(level = "debug") {
  let buffer = "";
  const logger = createLogger({
    level,
    destination: {
      write(chunk) {
        buffer += chunk;
      },
    },
  });
  return { logger, lines: () => parseJsonLines(buffer), raw: () => buffer };
}

const running = [];
afterAll(async () => {
  await Promise.all(running.map((worker) => worker.stop()));
});
async function start(extraEnv) {
  const worker = await startWorker(extraEnv);
  running.push(worker);
  return worker;
}

// ---------------------------------------------------------------------------------------------
// AC1: the health endpoint returns ok with queue and database status
// ---------------------------------------------------------------------------------------------

describe("AC1: health endpoint returns ok with queue and database status", () => {
  liveTest("AC1: GET /health with a reachable database returns 200 with db ok and queue not_configured (degraded)", async () => {
    const worker = await start({});
    const response = await fetch(worker.url("/health"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.db.status, "ok");
    assert.equal(body.queue.status, "not_configured");
    assert.equal(body.status, "degraded");
    assert.equal(typeof body.uptime_s, "number");
  });

  liveTest("AC1: GET /healthz is an alias of /health", async () => {
    const worker = await start({});
    const [health, healthz] = await Promise.all([
      fetch(worker.url("/health")).then((r) => r.json()),
      fetch(worker.url("/healthz")),
    ]);
    assert.equal(healthz.status, 200);
    const body = await healthz.json();
    assert.deepEqual({ ...body, uptime_s: 0 }, { ...health, uptime_s: 0 });
  });

  liveTest("AC1: a query string does not change the route", async () => {
    const worker = await start({});
    const response = await fetch(worker.url("/health?probe=1"));
    assert.equal(response.status, 200);
  });

  test("AC1: negative: database unreachable returns 503 with db down", async () => {
    const closedPort = await freePort();
    const worker = await start({
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${closedPort}/postgres`,
      HEALTH_DB_TIMEOUT_MS: "500",
    });
    const response = await fetch(worker.url("/health"));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "down");
    assert.equal(body.db.status, "down");
    assert.equal(body.queue.status, "not_configured");
  });

  test("AC1: negative: the worker stays up after a failed probe (second probe still 503)", async () => {
    const closedPort = await freePort();
    const worker = await start({
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${closedPort}/postgres`,
      HEALTH_DB_TIMEOUT_MS: "500",
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(worker.url("/health"));
      assert.equal(response.status, 503);
    }
    assert.equal(worker.exit, null, "worker process must not crash on a failed probe");
  });

  test("AC1: negative: unknown path returns 404, and non-GET methods on /health return 404", async () => {
    const worker = await start({});
    for (const path of ["/", "/metrics", "/health/extra", "/admin", "/.env"]) {
      const response = await fetch(worker.url(path));
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(worker.url("/health"), { method });
      assert.equal(response.status, 404, method);
    }
  });

  test("AC1: negative: the health body leaks no connection string, password, stack trace or env name", async () => {
    const closedPort = await freePort();
    const worker = await start({
      DATABASE_URL: `postgresql://qa_user:${DB_PASSWORD}@127.0.0.1:${closedPort}/postgres`,
      SUPABASE_SERVICE_ROLE_KEY: SECRET,
      HEALTH_DB_TIMEOUT_MS: "500",
    });
    const down = await fetch(worker.url("/health"));
    const text = await down.text();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["db", "queue", "status", "uptime_s"]);
    for (const needle of [DB_PASSWORD, SECRET, "qa_user", "postgres", "ECONNREFUSED", " at ", "stack", "127.0.0.1"]) {
      assert.ok(!text.includes(needle), `health body must not contain ${needle}: ${text}`);
    }
    const notFound = await (await fetch(worker.url("/nope"))).text();
    assert.equal(notFound, '{"error":"not_found"}');
    for (const output of [worker.stdout, worker.stderr]) {
      assert.ok(!output.includes(DB_PASSWORD), "logs must not contain the database password");
      assert.ok(!output.includes(SECRET), "logs must not contain secrets");
    }
  });

  test("AC1: edge: binds to IPv4 loopback by default (the IPv6 loopback does not answer)", async () => {
    const worker = await start({});
    const response = await fetch(worker.url("/health"));
    assert.equal(response.status, dbUp ? 200 : 503);
    const refused = await new Promise((resolveProbe) => {
      const socket = net.connect(worker.port, "::1");
      socket.once("connect", () => {
        socket.destroy();
        resolveProbe(false);
      });
      socket.once("error", () => resolveProbe(true));
    });
    assert.ok(refused, "worker must not listen on ::1 by default");
  });
});

// ---------------------------------------------------------------------------------------------
// AC2: logs are structured JSON with run and agent IDs
// ---------------------------------------------------------------------------------------------

describe("AC2: logs are structured JSON with run and agent ids", () => {
  test("AC2: every line the running worker writes is a JSON object with level, time, service and msg", async () => {
    const worker = await start({ LOG_LEVEL: "debug" });
    await fetch(worker.url("/health"));
    await fetch(worker.url("/missing"));
    const lines = parseJsonLines(worker.stdout);
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      assert.equal(typeof line, "object");
      assert.equal(line.service, "worker");
      assert.equal(typeof line.level, "string");
      assert.equal(typeof line.msg, "string");
      assert.match(line.time, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(!Number.isNaN(Date.parse(line.time)), `time must be an ISO timestamp: ${line.time}`);
    }
    assert.ok(lines.some((line) => line.msg === "worker started" && line.level === "info"));
  });

  test("AC2: withContext binds run_id, agent_id and workspace_id on every line", () => {
    const { logger, lines } = collectingLogger();
    const ctx = withContext(logger, { run_id: "run-1", agent_id: "agent-1", workspace_id: "ws-1" });
    ctx.info("step started");
    ctx.warn({ tool: "read_file" }, "tool warned");
    ctx.error(new Error("boom"), "step failed");
    const out = lines();
    assert.equal(out.length, 3);
    for (const line of out) {
      assert.equal(line.run_id, "run-1");
      assert.equal(line.agent_id, "agent-1");
      assert.equal(line.workspace_id, "ws-1");
      assert.equal(line.service, "worker");
    }
    assert.equal(out[1].tool, "read_file");
  });

  test("AC2: child contexts do not leak ids into the parent or sibling loggers", () => {
    const { logger, lines } = collectingLogger();
    const a = withContext(logger, { run_id: "run-a", agent_id: "agent-a", workspace_id: "ws-a" });
    const b = withContext(logger, { run_id: "run-b", agent_id: "agent-b", workspace_id: "ws-b" });
    logger.info("parent");
    a.info("from a");
    b.info("from b");
    const [parent, fromA, fromB] = lines();
    assert.equal(parent.run_id, undefined);
    assert.equal(parent.agent_id, undefined);
    assert.equal(fromA.run_id, "run-a");
    assert.equal(fromB.run_id, "run-b");
    assert.equal(fromB.agent_id, "agent-b");
  });

  test("AC2: edge: only the ids that are present are bound (no undefined or empty fields)", () => {
    const { logger, lines } = collectingLogger();
    withContext(logger, { run_id: "run-only" }).info("partial");
    const [line] = lines();
    assert.equal(line.run_id, "run-only");
    assert.ok(!("agent_id" in line));
    assert.ok(!("workspace_id" in line));
  });

  test("AC2: log level is honoured (debug is dropped at info, kept at debug)", () => {
    const quiet = collectingLogger("info");
    quiet.logger.debug("hidden");
    quiet.logger.info("shown");
    assert.deepEqual(
      quiet.lines().map((l) => l.msg),
      ["shown"],
    );
    const loud = collectingLogger("debug");
    loud.logger.debug("visible");
    assert.deepEqual(
      loud.lines().map((l) => l.msg),
      ["visible"],
    );
  });

  test("AC2: negative: secret-named keys are redacted (snake, camel, upper and nested shapes)", () => {
    const { logger, lines, raw } = collectingLogger();
    logger.info(
      {
        api_key: SECRET,
        apiKey: SECRET,
        password: SECRET,
        token: SECRET,
        access_token: SECRET,
        SUPABASE_SERVICE_ROLE_KEY: SECRET,
        ANTHROPIC_API_KEY: SECRET,
        TELEGRAM_BOT_TOKEN: SECRET,
        clientSecret: SECRET,
        nested: { deep: { authorization_token: SECRET, safe: "visible" } },
        list: [{ secret: SECRET }],
      },
      "secrets",
    );
    const [line] = lines();
    assert.ok(!raw().includes(SECRET), `secret leaked into log output: ${raw()}`);
    for (const key of [
      "api_key",
      "apiKey",
      "password",
      "token",
      "access_token",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ANTHROPIC_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "clientSecret",
    ]) {
      assert.equal(line[key], REDACTED, key);
    }
    assert.equal(line.nested.deep.authorization_token, REDACTED);
    assert.equal(line.nested.deep.safe, "visible");
    assert.equal(line.list[0].secret, REDACTED);
  });

  test("AC2: negative: credentialed URLs are stripped in messages, values and errors", () => {
    const { logger, raw } = collectingLogger();
    const url = `postgresql://postgres:${DB_PASSWORD}@db.example.com:5432/postgres`;
    logger.info(`connecting to ${url}`);
    logger.info({ connection: url, urls: [url, `redis://:${DB_PASSWORD}@cache:6379`] }, "values");
    logger.error(new Error(`connect failed for ${url}`), "error object");
    logger.error({ err: new Error(`failed ${url}`) }, "wrapped error");
    assert.ok(!raw().includes(DB_PASSWORD), `password leaked into log output: ${raw()}`);
    assert.ok(raw().includes("db.example.com"), "host should remain for debugging");
  });

  test("AC2: negative: a secret-named field logged through a bound context is still redacted", () => {
    const { logger, raw } = collectingLogger();
    withContext(logger, { run_id: "run-1" }).info({ token: SECRET }, "with token");
    assert.ok(!raw().includes(SECRET));
  });

  test("AC2: negative: a bad env fails with one JSON fatal line, exit 1, and never echoes the secret", () => {
    const result = runToExit({ APP_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: SECRET });
    assert.equal(result.status, 1);
    const lines = parseJsonLines(result.stderr);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "fatal");
    assert.equal(lines[0].service, "worker");
    assert.ok(!(result.stdout + result.stderr).includes(SECRET));
  });
});

// ---------------------------------------------------------------------------------------------
// Env check at start: a missing or invalid env exits 1 with a clear message and no secret echoed
// ---------------------------------------------------------------------------------------------

describe("Config: fail fast on invalid environment", () => {
  test("AC1: production without the required variables exits 1 naming them", () => {
    const result = runToExit({ APP_ENV: "production" });
    assert.equal(result.status, 1);
    const [line] = parseJsonLines(result.stderr);
    for (const name of ["DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      assert.ok(line.msg.includes(name), `message should name ${name}: ${line.msg}`);
    }
  });

  test("AC1: an invalid WORKER_PORT, LOG_LEVEL or HEALTH_DB_TIMEOUT_MS exits 1 naming the variable, not the value", () => {
    const cases = [
      ["WORKER_PORT", "99999-qa-bad"],
      ["WORKER_PORT", "70000"],
      ["LOG_LEVEL", "qa-loud"],
      ["HEALTH_DB_TIMEOUT_MS", "5"],
    ];
    for (const [name, value] of cases) {
      const result = runToExit({ [name]: value, DATABASE_URL: LOCAL_DB });
      assert.equal(result.status, 1, `${name}=${value}`);
      const [line] = parseJsonLines(result.stderr);
      assert.ok(line.msg.includes(name), `message should name ${name}: ${line.msg}`);
      assert.ok(!(result.stdout + result.stderr).includes(value), `${name} value must not be echoed`);
    }
  });

  test("AC1: a port that is already in use exits 1 with a clear JSON error", async () => {
    const holder = net.createServer();
    await new Promise((resolveListen) => holder.listen(0, "127.0.0.1", resolveListen));
    const { port } = holder.address();
    try {
      const result = runToExit({ WORKER_PORT: String(port), DATABASE_URL: LOCAL_DB });
      assert.equal(result.status, 1);
      const [line] = parseJsonLines(result.stderr);
      assert.equal(line.level, "fatal");
      assert.match(line.msg, /EADDRINUSE|address already in use/i);
    } finally {
      await new Promise((resolveClose) => holder.close(resolveClose));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AC3: the worker deploys from CI to the target host (image build + CI workflow; deploy is a
// documented manual placeholder until a human picks a host)
// ---------------------------------------------------------------------------------------------

describe("AC3: CI workflow builds the image; no host is chosen so deploy is a manual placeholder", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const dockerfile = readFileSync(DOCKERFILE, "utf8");

  test("AC3: workflow builds on pull requests, publishes only on push to main", () => {
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
    assert.match(workflow, /name: Log in to GHCR\s*\n\s*if: github\.event_name == 'push'/);
    assert.match(workflow, /push: \$\{\{ github\.event_name == 'push' \}\}/);
    assert.ok(!/pull_request_target/.test(workflow), "pull_request_target must not be used");
  });

  test("AC3: workflow uses minimal permissions, pinned actions and no persisted checkout credentials", () => {
    assert.match(workflow, /^permissions:\s*\n\s+contents: read/m);
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 3);
    for (const action of uses) {
      assert.match(action, /@[0-9a-f]{40}$/, `${action} must be pinned to a full commit SHA`);
    }
    assert.match(workflow, /persist-credentials: false/);
    const writers = workflow.match(/packages: write/g) ?? [];
    assert.equal(writers.length, 1, "packages: write must appear once, on the image job only");
    assert.ok(!/contents: write|id-token: write|pull-requests: write/.test(workflow));
  });

  test("AC3: the deploy job is a manual, always-failing placeholder behind the production environment", () => {
    // Start at the top-level `deploy:` job key (two-space indent), not the workflow_dispatch input.
    const deploy = workflow.slice(workflow.indexOf("\n  deploy:\n"));
    assert.match(deploy, /if: github\.event_name == 'workflow_dispatch' && inputs\.deploy/);
    assert.match(deploy, /needs: image/);
    assert.match(deploy, /environment: production/);
    assert.match(deploy, /exit 1/);
    assert.ok(!/secrets\./.test(deploy), "the placeholder must not read any secret");
    assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*deploy:[\s\S]*default: false/);
  });

  test("AC3: Dockerfile pins the base image by digest, runs as non-root and declares a healthcheck", () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.equal(froms.length, 2, "multi-stage build");
    for (const from of froms) assert.match(from, /@sha256:[0-9a-f]{64}$/);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^HEALTHCHECK /m);
    assert.ok(!/^ENV .*(KEY|SECRET|TOKEN|PASSWORD)/im.test(dockerfile), "no secret baked into the image");
  });
});

const dockerReady =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;

describe.skipIf(!dockerReady)("AC3: the Docker image builds, serves /health and shuts down gracefully", () => {
  const containers = [];

  function docker(args, options = {}) {
    return spawnSync("docker", args, { encoding: "utf8", ...options });
  }

  beforeAll(() => {
    const build = docker(["build", "-f", "apps/worker/Dockerfile", "-t", IMAGE, "."], {
      cwd: ROOT,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(build.status, 0, `docker build failed:\n${build.stdout}\n${build.stderr}`);
  }, 620_000);

  afterAll(() => {
    for (const name of containers) docker(["rm", "-f", name]);
    docker(["rmi", "-f", IMAGE]);
  });

  async function runContainer(env, publish = true) {
    const hostPort = await freePort();
    const name = `${IMAGE}-${hostPort}`;
    const args = ["run", "-d", "--name", name];
    if (publish) args.push("-p", `127.0.0.1:${hostPort}:8787`);
    // The container reaches the host-published local Postgres through host.docker.internal.
    args.push("--add-host", "host.docker.internal:host-gateway");
    for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
    args.push(IMAGE);
    const run = docker(args);
    assert.equal(run.status, 0, run.stderr);
    containers.push(name);
    return { name, hostPort };
  }

  async function waitForHealth(hostPort, attempts = 60) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fetch(`http://127.0.0.1:${hostPort}/health`);
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    assert.fail("container never answered /health");
  }

  liveTest("AC3: container serves /health with the local database and runs as a non-root user", async () => {
    const { name, hostPort } = await runContainer({
      APP_ENV: "local",
      DATABASE_URL: "postgresql://postgres:postgres@host.docker.internal:44322/postgres",
    });
    const response = await waitForHealth(hostPort);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.db.status, "ok");
    assert.equal(body.queue.status, "not_configured");
    assert.equal(body.status, "degraded");
    const whoami = docker(["exec", name, "id", "-u"]);
    assert.notEqual(whoami.stdout.trim(), "0", "container must not run as root");
    for (const line of parseJsonLines(docker(["logs", name]).stdout)) {
      assert.equal(line.service, "worker");
    }
  }, 60_000);

  test("AC3: negative: container without APP_ENV exits 1 with a JSON fatal line", async () => {
    const { name } = await runContainer({}, false);
    const waited = docker(["wait", name], { timeout: 30_000 });
    assert.equal(waited.stdout.trim(), "1");
    const logs = docker(["logs", name]);
    const [line] = parseJsonLines(logs.stderr);
    assert.equal(line.level, "fatal");
    assert.match(line.msg, /APP_ENV/);
  }, 60_000);

  test("AC3: SIGTERM shuts the container down gracefully with exit code 0", async () => {
    const { name, hostPort } = await runContainer({
      APP_ENV: "local",
      DATABASE_URL: "postgresql://postgres:postgres@host.docker.internal:44322/postgres",
    });
    await waitForHealth(hostPort);
    const killed = docker(["kill", "--signal=SIGTERM", name]);
    assert.equal(killed.status, 0, killed.stderr);
    const waited = docker(["wait", name], { timeout: 30_000 });
    assert.equal(waited.stdout.trim(), "0", "graceful shutdown must exit 0");
    const messages = parseJsonLines(docker(["logs", name]).stdout).map((line) => line.msg);
    assert.ok(messages.includes("shutting down"), messages.join(","));
    assert.ok(messages.includes("worker stopped"), messages.join(","));
  }, 60_000);
});
