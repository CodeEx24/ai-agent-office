/**
 * AGO-70 acceptance tests (QA). One test per acceptance criterion, plus negative cases.
 * Run with `node --test scripts/ago-70-acceptance.test.mjs` (also part of `pnpm test`).
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
import { test } from "node:test";
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
    "a.js": CLIENT_ENV_NAMES.map((name) => `process.env.${name};`).join("") + 'const u="http://127.0.0.1:55421";',
  };
  withBundle(files, (dir) => {
    const findings = scanBundle(dir, {
      serverNames: SERVER_ONLY_ENV_NAMES,
      env: { APP_ENV: "local", SUPABASE_URL: "http://127.0.0.1:55421" },
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
