import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isSecretName, scanBundle } from "./check-client-bundle.mjs";

const SERVER_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL", "TELEGRAM_BOT_TOKEN"];
const FAKE_SECRET = "fixture-secret-value-0123456789";

function withBundle(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "ago-bundle-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("clean bundle with only NEXT_PUBLIC values passes", () => {
  withBundle(
    { "chunks/app.js": 'const u="http://127.0.0.1:55421";const k=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;' },
    (dir) => assert.deepEqual(scanBundle(dir, { serverNames: SERVER_NAMES, env: {} }), []),
  );
});

test("fixture: server-only variable name in the bundle fails", () => {
  withBundle({ "chunks/leak.js": "fetch(process.env.SUPABASE_SERVICE_ROLE_KEY)" }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_NAMES, env: {} });
    assert.ok(findings.some((f) => f.name === "SUPABASE_SERVICE_ROLE_KEY"));
  });
});

test("fixture: unknown secret-named process.env reference fails", () => {
  withBundle({ "chunks/leak.js": 'const t=process.env["STRIPE_WEBHOOK_SECRET"];' }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_NAMES, env: {} });
    assert.deepEqual(findings.map((f) => f.name), ["STRIPE_WEBHOOK_SECRET"]);
  });
});

test("fixture: known secret value in the bundle fails and is never reported", () => {
  withBundle({ "chunks/leak.js": `const x="${FAKE_SECRET}";` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_NAMES, env: { TELEGRAM_BOT_TOKEN: FAKE_SECRET } });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, "TELEGRAM_BOT_TOKEN");
    assert.ok(!JSON.stringify(findings).includes(FAKE_SECRET));
  });
});

test("non-secret server values (APP_ENV, SUPABASE_URL) in a bundle are not flagged", () => {
  withBundle({ "a.js": 'if(process.env.NODE_ENV==="production"){fetch("https://x.example.test")}' }, (dir) =>
    assert.deepEqual(
      scanBundle(dir, {
        serverNames: ["APP_ENV", "SUPABASE_URL"],
        env: { APP_ENV: "production", SUPABASE_URL: "https://x.example.test" },
      }),
      [],
    ),
  );
});

test("DATABASE_URL value in a bundle fails", () => {
  const dsn = "postgresql://user:pw-fixture@db.example.test:5432/postgres";
  withBundle({ "a.js": `const d="${dsn}";` }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_NAMES, env: { DATABASE_URL: dsn } });
    assert.ok(findings.some((f) => f.name === "DATABASE_URL" && f.reason === "secret value present"));
  });
});

test("NEXT_PUBLIC_ names and short values are not flagged", () => {
  assert.equal(isSecretName("NEXT_PUBLIC_SUPABASE_ANON_KEY"), false);
  assert.equal(isSecretName("SUPABASE_SERVICE_ROLE_KEY"), true);
  withBundle({ "a.js": 'const e="local";' }, (dir) =>
    assert.deepEqual(scanBundle(dir, { serverNames: ["APP_ENV"], env: { APP_ENV: "local" } }), []),
  );
});

test("connection string with embedded credentials is flagged whatever the variable name", () => {
  withBundle({ "a.js": 'const c="postgres://app:hunter2pw@db.example.test:5432/app";' }, (dir) => {
    const findings = scanBundle(dir, { serverNames: SERVER_NAMES, env: {} });
    assert.deepEqual(findings.map((f) => f.name), ["CONNECTION_STRING"]);
    assert.ok(!JSON.stringify(findings).includes("hunter2pw"));
  });
});

test("URLs without credentials are not flagged as connection strings", () => {
  withBundle({ "a.js": 'fetch("https://app.example.test/path?x=a:b@c");fetch("postgres://db.example.test:5432/app")' }, (dir) =>
    assert.deepEqual(scanBundle(dir, { serverNames: SERVER_NAMES, env: {} }), []),
  );
});

test("names are matched case-insensitively", () => {
  withBundle({ "a.js": "x(process.env.next_public_database_url);x(process.env.database_url)" }, (dir) => {
    const names = scanBundle(dir, { serverNames: ["DATABASE_URL"], env: {} }).map((f) => f.name).sort();
    assert.ok(names.includes("DATABASE_URL") && names.includes("next_public_database_url"), names.join());
  });
});
