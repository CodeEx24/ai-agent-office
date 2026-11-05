import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLIENT_ENV_NAMES, SERVER_ONLY_ENV_NAMES } from "@ago/shared";

import { expect, test } from "./fixtures";
import { HomePage } from "./pages/home-page";

// AGO-70 acceptance criteria, observed from outside: the production build served by `next start`,
// the built client bundle, and the build check. `playwright test` runs from apps/web.
const WEB_DIR = process.cwd();
const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const NEXT_BIN = path.join(WEB_DIR, "node_modules/next/dist/bin/next");
const BUNDLE_DIR = path.join(WEB_DIR, ".next/static");
const BUNDLE_CHECK = path.join(REPO_ROOT, "scripts/check-client-bundle.mjs");

// A value planted into the child's environment. It must never appear in anything the app prints.
const PLANTED_SECRET = "planted-secret-value-4f9c1e7a";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

interface StartedServer {
  status: number;
  body: string;
  logs: string;
}

/**
 * Start the already built app as a separate production process with exactly `env` (no inherited
 * variables except PATH), wait for it to answer, and return what a user would get.
 */
async function startProduction(env: Record<string, string>): Promise<StartedServer> {
  const port = await getFreePort();
  let logs = "";
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: WEB_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_ENV: "production",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (logs += chunk.toString()));

  try {
    let response: { status: number; body: string } | undefined;
    await expect
      .poll(
        async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${String(port)}/`);
            response = { status: res.status, body: await res.text() };
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 60_000, message: "the production server never started answering" },
      )
      .toBe(true);
    // Let the instrumentation error reach the log before it is read.
    await expect.poll(() => logs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    if (!response) throw new Error("no response captured");
    return { status: response.status, body: response.body, logs };
  } finally {
    child.kill();
  }
}

test.describe("AGO-70 environment config", () => {
  test("AC1: the app starts with the local defaults and renders the home page", async ({
    page,
  }) => {
    const home = new HomePage(page);

    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle("Agent Office");
    await expect(home.heading).toBeVisible();
  });

  test("AC1: production without APP_ENV never serves a page, names APP_ENV and prints no values", async () => {
    const started = await startProduction({
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:44321",
      SUPABASE_SERVICE_ROLE_KEY: PLANTED_SECRET,
    });

    expect(started.status).toBe(500);
    expect(started.body).not.toContain("Agent Office");
    expect(started.logs).toContain("APP_ENV: missing");
    expect(started.logs).not.toContain(PLANTED_SECRET);
  });

  test("AC1: production with APP_ENV=production and keys missing never serves a page and names each variable", async () => {
    const started = await startProduction({ APP_ENV: "production" });

    expect(started.status).toBe(500);
    expect(started.body).not.toContain("Agent Office");
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "DATABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]) {
      expect(started.logs).toContain(`${name}: missing`);
    }
  });

  test("AC1: a secret under a NEXT_PUBLIC_ name is refused at startup, naming it but not its value", async () => {
    const started = await startProduction({
      APP_ENV: "local",
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: PLANTED_SECRET,
    });

    expect(started.status).toBe(500);
    expect(started.body).not.toContain("Agent Office");
    expect(started.logs).toContain("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY");
    expect(started.logs).not.toContain(PLANTED_SECRET);
  });

  test("AC2: the served home page and built client bundle contain no server-only variable name", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|css|html|json|map|txt)$/.test(entry.name)) files.push(full);
      }
    };
    walk(BUNDLE_DIR);
    expect(files.length, "the build must have produced client files").toBeGreaterThan(0);

    const surfaces = [
      { where: "served /", text: html },
      ...files.map((f) => ({ where: path.relative(WEB_DIR, f), text: readFileSync(f, "utf8") })),
    ];
    const leaks = surfaces.flatMap(({ where, text }) =>
      SERVER_ONLY_ENV_NAMES.filter((name) => text.includes(name)).map(
        (name) => `${name} in ${where}`,
      ),
    );

    expect(leaks).toEqual([]);
  });

  test.describe("build check", () => {
    let fixtureDir: string;

    test.beforeEach(() => {
      fixtureDir = mkdtempSync(path.join(tmpdir(), "ago-70-bundle-"));
      mkdirSync(path.join(fixtureDir, "static"));
    });
    test.afterEach(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    const runCheck = (dir: string) =>
      spawnSync(process.execPath, [BUNDLE_CHECK, dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          NODE_ENV: "test",
          SUPABASE_SERVICE_ROLE_KEY: PLANTED_SECRET,
        },
      });

    test("AC2: the build check passes on the real client bundle", () => {
      const result = runCheck(BUNDLE_DIR);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OK");
    });

    test("AC2: the build check fails when a secret-named variable or its value reaches the bundle, printing names only", () => {
      writeFileSync(
        path.join(fixtureDir, "static", "leak.js"),
        `var a=process.env.SUPABASE_SERVICE_ROLE_KEY;var b="${PLANTED_SECRET}";var c=process.env.NEXT_PUBLIC_API_TOKEN;`,
      );

      const result = runCheck(fixtureDir);
      const output = result.stdout + result.stderr;

      expect(result.status).not.toBe(0);
      expect(output).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(output).toContain("NEXT_PUBLIC_API_TOKEN");
      expect(output).not.toContain(PLANTED_SECRET);
    });

    test("AC2: the build check fails when the bundle directory is missing instead of passing silently", () => {
      const result = runCheck(path.join(fixtureDir, "does-not-exist"));

      expect(result.status).not.toBe(0);
    });
  });

  test("AC3: .env.example lists every variable with placeholders only", () => {
    const text = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    const entries = new Map(
      text
        .split(/\r?\n/)
        .map((line) => /^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1] ?? "", (m[2] ?? "").trim()] as const),
    );

    const missing = [...SERVER_ONLY_ENV_NAMES, ...CLIENT_ENV_NAMES].filter(
      (name) => !entries.has(name),
    );
    expect(missing, "variables absent from .env.example").toEqual([]);

    // The only credentialed URL allowed is the public local-Supabase default (postgres:postgres on
    // loopback). Any other user:password@host, or any known secret shape, is a real-looking secret.
    const LOCAL_DEFAULT_LOGIN = /^[a-z]+:\/\/postgres:postgres@(127\.0\.0\.1|localhost)[:/]/;
    const realLooking = [...entries].filter(
      ([, value]) =>
        !LOCAL_DEFAULT_LOGIN.test(value) &&
        /sk-ant-|sbp_|sb_secret_|^eyJ|\/\/[^/\s:@]*:[^/\s@]{4,}@/.test(value),
    );
    expect(
      realLooking.map(([name]) => name),
      "values that look like real secrets",
    ).toEqual([]);
  });
});
