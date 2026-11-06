/**
 * AGO-70 acceptance tests (QA). One test per acceptance criterion, plus negative cases.
 * Run with `vitest run scripts/ago-70-acceptance.test.mjs` (also part of `pnpm test`).
 *
 * Needs `packages/shared/dist` and `apps/worker/dist` (pnpm build). No `.env*` file is read or
 * written: every environment is passed on the child process command line.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { scanBundle } from "./check-client-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SCRIPT = join(ROOT, "scripts", "check-client-bundle.mjs");
const WEB_DIR = join(ROOT, "apps", "web");
const NEXT_BIN = join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");

const SHARED = await import(new URL("../packages/shared/dist/index.js", import.meta.url).href);
const { SERVER_ONLY_ENV_NAMES, CLIENT_ENV_NAMES } = SHARED;

/** A value that must never appear in any output. */
const SECRET = "qa-secret-value-7f3a9c1e5b2d";
const BAD_URL = "qa-not-a-url-zzz";

/** Child-process env: only PATH-like basics plus what the test passes (never inherits secrets). */
function cleanEnv(extra) {
  const base = {};
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  return { ...base, ...extra };
}

function runWorkerEnv(extra) {
  const script = `import("${new URL("../apps/worker/dist/env.js", import.meta.url).href}")
    .then((m) => { m.loadWorkerEnv(); console.log("ENV_OK"); })
    .catch((e) => { console.error(e.message); process.exit(1); });`;
  return spawnSync(process.execPath, ["-e", script], { env: cleanEnv(extra), encoding: "utf8" });
}

function withBundle(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "ago70-qa-bundle-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBundleCheck(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, dir], { env: cleanEnv(extraEnv), encoding: "utf8" });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    // Default host is dual-stack, which is what `next dev` binds; avoids EADDRINUSE on `::`.
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Start the real web app and resolve with its combined output once `predicate(output)` holds. */
async function startWebAndWait(extraEnv, predicate, timeoutMs = 90_000) {
  const port = await freePort();
  const child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port)], {
    cwd: WEB_DIR,
    env: cleanEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    return await new Promise((resolveOutput, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for web app output:\n${output}`)), timeoutMs);
      const onData = (chunk) => {
        output += chunk.toString();
        if (predicate(output)) {
          clearTimeout(timer);
          resolveOutput(output);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", () => {
        if (!predicate(output)) {
          clearTimeout(timer);
          reject(new Error(`web app exited before the expected output:\n${output}`));
        }
      });
    });
  } finally {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// AC1: Given a missing required env var, when the app starts, then it fails with a clear message
// ---------------------------------------------------------------------------------------------

test("AC1: web app fails fast at startup naming the missing variables and never printing values", async () => {
  const output = await startWebAndWait(
    { APP_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: SECRET },
    (text) => text.includes("Invalid environment configuration"),
  );
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_URL"]) {
    assert.ok(output.includes(name), `startup error should name ${name}`);
  }
  assert.ok(!output.includes(SECRET), "startup error must not print a variable value");
});

test("AC1: worker env load exits non-zero, names every missing variable, prints no values (APP_ENV=production)", () => {
  const result = runWorkerEnv({ APP_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: SECRET });
  assert.notEqual(result.status, 0);
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_URL"]) {
    assert.ok(result.stderr.includes(name), `stderr should name ${name}`);
  }
  assert.ok(!result.stderr.includes("SUPABASE_SERVICE_ROLE_KEY"), "a variable that is set must not be reported");
  assert.ok(!(result.stdout + result.stderr).includes(SECRET), "output must not contain a value");
});

test("AC1: worker env load rejects an invalid (non-URL) value, naming the variable but not the value", () => {
  const result = runWorkerEnv({ SENTRY_DSN: BAD_URL, LANGFUSE_HOST: BAD_URL });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("SENTRY_DSN"));
  assert.ok(result.stderr.includes("LANGFUSE_HOST"));
  assert.ok(!result.stderr.includes(BAD_URL), "output must not contain the invalid value");
});

test("AC1: empty strings count as missing in production (not silently accepted)", () => {
  const result = runWorkerEnv({ APP_ENV: "production", DATABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("DATABASE_URL"));
  assert.ok(result.stderr.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

test("AC1: production rejects http URLs and an unknown APP_ENV is rejected", () => {
  const http = runWorkerEnv({
    APP_ENV: "production",
    NEXT_PUBLIC_APP_URL: "http://app.example.test",
    NEXT_PUBLIC_SUPABASE_URL: "http://project.example.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder",
    SUPABASE_URL: "http://project.example.test",
    SUPABASE_SERVICE_ROLE_KEY: SECRET,
    DATABASE_URL: "postgres://placeholder",
  });
  assert.notEqual(http.status, 0);
  assert.ok(http.stderr.includes("must use https"));

  const unknown = runWorkerEnv({ APP_ENV: "staging" });
  assert.notEqual(unknown.status, 0);
  assert.ok(unknown.stderr.includes("APP_ENV"));
});

test("AC1: local environment starts with nothing set (safe defaults)", () => {
  const result = runWorkerEnv({});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("ENV_OK"));
});

// ---------------------------------------------------------------------------------------------
// AC2: A build check fails if a secret-named var reaches the client bundle
// ---------------------------------------------------------------------------------------------

test("AC2: CLI exits 0 on a clean bundle and non-zero (naming file and variable only) on a leak", () => {
  withBundle({ "chunks/clean.js": "const k=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;" }, (dir) => {
    const ok = runBundleCheck(dir);
    assert.equal(ok.status, 0, ok.stderr);
  });
  withBundle({ "chunks/leak.js": `fetch(process.env.SUPABASE_SERVICE_ROLE_KEY,"${SECRET}")` }, (dir) => {
    const bad = runBundleCheck(dir, { SUPABASE_SERVICE_ROLE_KEY: SECRET });
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes("SUPABASE_SERVICE_ROLE_KEY"));
    assert.ok(bad.stderr.includes("leak.js"));
    assert.ok(!(bad.stdout + bad.stderr).includes(SECRET), "the check must never print the secret value");
  });
});

test("AC2: every server-only variable name in a client bundle is flagged", () => {
  for (const name of SERVER_ONLY_ENV_NAMES) {
    withBundle({ "a.js": `x(process.env.${name})` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} });
      assert.ok(findings.some((f) => f.name === name), `${name} should be flagged`);
    });
  }
});

test("AC2: a server variable imported into a client component (bracket access) is flagged", () => {
  withBundle({ "a.js": 'const k=process.env["TELEGRAM_BOT_TOKEN"];' }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} });
    assert.ok(findings.some((f) => f.name === "TELEGRAM_BOT_TOKEN"));
  });
});

test("AC2: secret value inlined into the bundle is flagged, and the report never contains the value", () => {
  withBundle({ "chunks/a.js": `const k="${SECRET}";` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { ANTHROPIC_API_KEY: SECRET } });
    assert.ok(findings.some((f) => f.name === "ANTHROPIC_API_KEY"));
    assert.ok(!JSON.stringify(findings).includes(SECRET));
  });
});

test("AC2 (bypass): a NEXT_PUBLIC_-prefixed service-role key reference is flagged", () => {
  withBundle({ "a.js": "const k=process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;" }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} });
    assert.ok(findings.length > 0, "NEXT_PUBLIC_ prefix on a service-role key must not bypass the check");
  });
});

test("AC2 (bypass): a NEXT_PUBLIC_-prefixed API key / token / secret reference is flagged", () => {
  for (const name of ["NEXT_PUBLIC_ANTHROPIC_API_KEY", "NEXT_PUBLIC_TELEGRAM_BOT_TOKEN", "NEXT_PUBLIC_LANGFUSE_SECRET_KEY"]) {
    withBundle({ "a.js": `const k=process.env.${name};` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} });
      assert.ok(findings.length > 0, `${name} must be flagged`);
    });
  }
});

test("AC2 (bypass): the value of a secret exposed under a NEXT_PUBLIC_ name is flagged", () => {
  withBundle({ "a.js": `const k="${SECRET}";` }, (dir) => {
    const findings = scanBundle(dir, {
      serverNames: SERVER_ONLY_ENV_NAMES,
      env: { NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: SECRET },
    });
    assert.ok(findings.length > 0, "a secret value must be caught even when set under a NEXT_PUBLIC_ name");
  });
});

test("AC2: allowed NEXT_PUBLIC_ variables and non-secret server values do not trip the check", () => {
  const files = {
    "a.js": CLIENT_ENV_NAMES.map((name) => `process.env.${name};`).join("") + 'const u="http://127.0.0.1:44321";',
  };
  withBundle(files, (dir) => {
    const findings = scanBundle(dir, {
      serverNames: SERVER_ONLY_ENV_NAMES,
      env: { APP_ENV: "local", SUPABASE_URL: "http://127.0.0.1:44321" },
    });
    assert.deepEqual(findings, []);
  });
});

test("AC2: a missing bundle directory is an error, not a silent pass", () => {
  const result = runBundleCheck(join(tmpdir(), "ago70-qa-does-not-exist"));
  assert.notEqual(result.status, 0);
});

// ---------------------------------------------------------------------------------------------
// AC3: .env.example lists every variable
// (Content is deliberately not read here while the owner's deny rule on .env* is in place; the
// variable set below is the one the coordinator verified against the file. Add a content check
// once the rule is lifted: see docs/tickets/AGO-70.md, Follow-up tasks.)
// ---------------------------------------------------------------------------------------------

test("AC3: .env.example is tracked by git", () => {
  const out = execFileSync("git", ["ls-files", ".env.example"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.equal(out, ".env.example");
});

test("AC3: the schema defines exactly the documented set of variables", () => {
  const expected = [
    "APP_ENV",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "SENTRY_DSN",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_HOST",
  ].sort();
  assert.deepEqual([...SERVER_ONLY_ENV_NAMES, ...CLIENT_ENV_NAMES].sort(), expected);
});

// ---------------------------------------------------------------------------------------------
// Re-test after fix round 1 (NEXT_PUBLIC_ prefix must not launder a secret into the browser)
// ---------------------------------------------------------------------------------------------

const PUBLIC_SECRET_NAMES = [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_PRIVATE_KEY",
  "NEXT_PUBLIC_DB_PASSWORD",
  "NEXT_PUBLIC_GITHUB_TOKEN",
];

test("AC1 (bypass): startup rejects secret-like NEXT_PUBLIC_ variables, naming them and never printing values", () => {
  for (const name of PUBLIC_SECRET_NAMES) {
    const result = runWorkerEnv({ [name]: SECRET });
    assert.notEqual(result.status, 0, `${name} must fail startup`);
    assert.ok(result.stderr.includes(name), `stderr should name ${name}`);
    assert.ok(!(result.stdout + result.stderr).includes(SECRET), `${name}: output must not contain the value`);
  }
});

test("AC1 (bypass): the web app refuses to start with a NEXT_PUBLIC_ service-role key, without printing it", async () => {
  const output = await startWebAndWait(
    { NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: SECRET },
    (text) => text.includes("Invalid environment configuration"),
  );
  assert.ok(output.includes("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY"));
  assert.ok(!output.includes(SECRET), "startup error must not print a variable value");
});

test("AC1: the public anon key under its NEXT_PUBLIC_ name is accepted at startup", () => {
  const result = runWorkerEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: SECRET });
  assert.equal(result.status, 0, result.stderr);
});

test("AC2 (bypass): NEXT_PUBLIC_ plus *_PRIVATE_KEY / *_PASSWORD / *_TOKEN is flagged by reference and by value", () => {
  for (const name of PUBLIC_SECRET_NAMES) {
    withBundle({ "a.js": `x(process.env.${name})` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} });
      assert.ok(findings.some((f) => f.name === name), `${name} reference must be flagged`);
    });
    withBundle({ "a.js": `x("${SECRET}")` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { [name]: SECRET } });
      assert.ok(findings.some((f) => f.name === name), `${name} value must be flagged`);
      assert.ok(!JSON.stringify(findings).includes(SECRET), "report must not contain the value");
    });
  }
});

test("AC2 (bypass): the public anon key reference is not a false positive", () => {
  withBundle({ "a.js": "x(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)" }, (dir) => {
    assert.deepEqual(scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: {} }), []);
  });
});

test("AC2 (allowlist): only APP_ENV, SUPABASE_URL, LANGFUSE_HOST and SENTRY_DSN values may appear in a bundle", () => {
  const allowed = {
    APP_ENV: "production",
    SUPABASE_URL: "https://project.example.test",
    LANGFUSE_HOST: "https://langfuse.example.test",
    SENTRY_DSN: "https://publickey@o0.ingest.sentry.example.test/1",
  };
  withBundle({ "a.js": Object.values(allowed).map((v) => `x("${v}");`).join("") }, (dir) => {
    assert.deepEqual(scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: allowed }), []);
  });
  for (const name of SERVER_ONLY_ENV_NAMES.filter((n) => !(n in allowed))) {
    withBundle({ "a.js": `x("${SECRET}")` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { [name]: SECRET } });
      assert.ok(findings.some((f) => f.name === name), `the value of ${name} must be flagged`);
    });
  }
});

// Round 2 (head 8fa43c6): a server-only variable under a NEXT_PUBLIC_ name is rejected by classification.
test("AC2 (bypass): startup rejects NEXT_PUBLIC_DATABASE_URL (a server-only variable under a public name)", () => {
  const result = runWorkerEnv({ NEXT_PUBLIC_DATABASE_URL: `postgres://user:${SECRET}@db.example.test:5432/app` });
  assert.notEqual(result.status, 0, "NEXT_PUBLIC_DATABASE_URL would put database credentials in the browser");
  assert.ok(result.stderr.includes("NEXT_PUBLIC_DATABASE_URL"));
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
});

test("AC2 (bypass): a database URL value exposed under NEXT_PUBLIC_DATABASE_URL is flagged in the bundle", () => {
  const url = `postgres://user:${SECRET}@db.example.test:5432/app`;
  withBundle({ "a.js": `x("${url}")` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { NEXT_PUBLIC_DATABASE_URL: url } });
    assert.ok(findings.length > 0, "database credentials must not reach the client bundle under a public name");
  });
});

// ---------------------------------------------------------------------------------------------
// Round 3 (head 8fa43c6): further bypasses of the same class, found by building a client page that
// reads each NEXT_PUBLIC_ name and running the real `next build` + check.
// ---------------------------------------------------------------------------------------------

const PG_URL = `postgresql://postgres:${SECRET}@db.example.test:5432/postgres`;

test("AC2 (bypass): a credential URL under a NEXT_PUBLIC_ twin name (SUPABASE_DB_URL, POSTGRES_URL) is flagged in the bundle", () => {
  for (const name of ["NEXT_PUBLIC_SUPABASE_DB_URL", "NEXT_PUBLIC_POSTGRES_URL"]) {
    withBundle({ "a.js": `x("${PG_URL}")` }, (dir) => {
      const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { [name]: PG_URL } });
      assert.ok(findings.length > 0, `${name}: database credentials must not reach the client bundle`);
      assert.ok(!JSON.stringify(findings).includes(SECRET), "report must not contain the value");
    });
  }
});

test("AC2 (bypass): a credential URL with an empty username (redis://:password@host) is flagged in the bundle", () => {
  const url = `redis://:${SECRET}@cache.example.test:6379`;
  withBundle({ "a.js": `x("${url}")` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { NEXT_PUBLIC_REDIS_URL: url } });
    assert.ok(findings.length > 0, "a password-only connection URL must not reach the client bundle");
    assert.ok(!JSON.stringify(findings).includes(SECRET), "report must not contain the value");
  });
});

test("AC2 (bypass): a typo-like twin of a server-only name (NEXT_PUBLIC_ANTHROPIC_APIKEY) is rejected at startup", () => {
  const result = runWorkerEnv({ NEXT_PUBLIC_ANTHROPIC_APIKEY: SECRET });
  assert.notEqual(result.status, 0, "an API key under a NEXT_PUBLIC_ name would ship to the browser");
  assert.ok(result.stderr.includes("NEXT_PUBLIC_ANTHROPIC_APIKEY"));
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
});

test("AC2 (bypass): a typo-like twin of a server-only name (NEXT_PUBLIC_ANTHROPIC_APIKEY) is flagged in the bundle", () => {
  withBundle({ "a.js": `x("${SECRET}")` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_ONLY_ENV_NAMES, env: { NEXT_PUBLIC_ANTHROPIC_APIKEY: SECRET } });
    assert.ok(findings.length > 0, "an API key value must not reach the client bundle under an unusual public name");
  });
});

test("AC2 (false positive): a production client bundle with the anon key and public URLs passes while server secrets are set", () => {
  const env = {
    APP_ENV: "production",
    NEXT_PUBLIC_APP_URL: "https://office.example.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.example.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJanon-public-key-0123456789",
    SUPABASE_URL: "https://project.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "eyJservice-role-secret-0123456789",
    DATABASE_URL: PG_URL,
    ANTHROPIC_API_KEY: "sk-ant-api03-qa0123456789abcdefghij",
  };
  const bundle = [
    env.NEXT_PUBLIC_APP_URL,
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    env.APP_ENV,
  ].map((v) => `x("${v}");`).join("");
  withBundle({ "a.js": bundle }, (dir) => {
    assert.equal(runBundleCheck(dir, env).status, 0);
  });
});

// ---- Round 3 re-test (deny-by-default): innocent-looking undeclared public variables ----

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwtWithRole = (role) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ role, iss: "supabase-demo" })}.qa-signature-0123456789`;

test("AC1 (deny by default): an undeclared NEXT_PUBLIC_ variable with an innocent name is rejected at startup, naming it but not its value", () => {
  const value = "qa-feature-value-9d41c7";
  const result = runWorkerEnv({ NEXT_PUBLIC_FEATURE_X: value });
  assert.notEqual(result.status, 0, "an undeclared public variable would be bundled into the browser unreviewed");
  assert.ok(result.stderr.includes("NEXT_PUBLIC_FEATURE_X"), result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes(value), "the value must never be printed");
});

test("AC1 (deny by default): the same rejection applies in production alongside the other missing variables", () => {
  const result = runWorkerEnv({ APP_ENV: "production", NEXT_PUBLIC_FEATURE_X: "1" });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("NEXT_PUBLIC_FEATURE_X"));
  assert.ok(result.stderr.includes("SUPABASE_SERVICE_ROLE_KEY"), "the missing production variables are still reported together");
});

test("AC2 (deny by default): a reference to an undeclared innocent NEXT_PUBLIC_ variable fails the bundle check CLI, in any case", () => {
  for (const reference of ["process.env.NEXT_PUBLIC_FEATURE_X", "process.env.next_public_feature_x", 'process.env["Next_Public_Feature_X"]']) {
    withBundle({ "chunks/a.js": `x(${reference})` }, (dir) => {
      const result = runBundleCheck(dir);
      assert.equal(result.status, 1, `${reference} must fail the build check`);
      assert.match(result.stderr.toUpperCase(), /NEXT_PUBLIC_FEATURE_X/);
    });
  }
});

test("AC2 (deny by default): an inlined value of an undeclared NEXT_PUBLIC_ variable fails the CLI, and the report never contains it", () => {
  const value = "enabled-for-everyone-7c2e";
  withBundle({ "chunks/a.js": `var f="${value}";` }, (dir) => {
    const result = runBundleCheck(dir, { NEXT_PUBLIC_FEATURE_X: value });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("NEXT_PUBLIC_FEATURE_X"));
    assert.ok(!(result.stdout + result.stderr).includes(value));
  });
});

test("AC2 (bypass): mixed-case NEXT_PUBLIC_ service-role names are flagged by reference and by value through the CLI", () => {
  const key = jwtWithRole("service_role");
  withBundle({ "chunks/a.js": `x(process.env.NEXT_PUBLIC_Supabase_Service_Role_Key);x("${key}")` }, (dir) => {
    const result = runBundleCheck(dir, { NEXT_PUBLIC_Supabase_Service_Role_Key: key });
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(key));
  });
});

test("AC2 (false positive): an anon-role JWT in the bundle passes while a service_role JWT is set on the server; swapping the roles fails", () => {
  const anon = jwtWithRole("anon");
  const service = jwtWithRole("service_role");
  const env = { NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service };
  withBundle({ "chunks/a.js": `x("${anon}")` }, (dir) => assert.equal(runBundleCheck(dir, env).status, 0));
  withBundle({ "chunks/a.js": `x("${service}")` }, (dir) => assert.equal(runBundleCheck(dir, env).status, 1));
});

test("AC2 (bypass): an empty-username credential URL (redis://:pw@host) fails the CLI whatever the variable is called", () => {
  withBundle({ "chunks/a.js": 'x("redis://:s3cretpw@cache.example.test:6379")' }, (dir) => {
    const result = runBundleCheck(dir);
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes("s3cretpw"));
  });
});
