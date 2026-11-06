import { expect, test } from "./fixtures";
import {
  connectSrc,
  errorEventsOf,
  startAppServer,
  startFakeIngest,
  type AppServer,
  type FakeIngest,
} from "./support/sentry-ingest";

// AGO-104 (error tracking). A LOCAL fake ingest stands in for Sentry; nothing leaves the machine.
// "Real Sentry receives an event" stays pending the owner's DSN.
//
// The browser DSN (NEXT_PUBLIC_SENTRY_DSN) is inlined at BUILD time, so the browser-capture spec
// below needs a build made with it. It runs only when that build exists:
//   E2E_SENTRY_INGEST_PORT=<port> NEXT_PUBLIC_SENTRY_DSN=http://publickey@127.0.0.1:<port>/1 pnpm build
//   E2E_SENTRY_INGEST_PORT=<port> PORT=$(node scripts/free-port.mjs) pnpm test:e2e
// Every other spec here runs against the normal (no-DSN) build, in CI too.

// Each spec below may boot one or two extra production servers; give them room.
test.describe.configure({ timeout: 120_000 });

/** Set when this run uses a build made with a browser DSN (see the header). */
const ingestPort = Number(process.env.E2E_SENTRY_INGEST_PORT ?? 0);

const SERVER_READY = async (baseUrl: string): Promise<boolean> =>
  (await fetch(`${baseUrl}/`)).status === 200;

/** Secret-shaped values built at runtime so no secret literal sits in the source (gitleaks). */
const SECRET_CORE = "Qz8w".repeat(10);
const SECRETS = {
  bearer: `Authorization: Bearer ${SECRET_CORE}`,
  apikey: `https://x.example.test/cb?apikey=${SECRET_CORE}`,
  jwt: `eyJ${"hD1r".repeat(5)}.eyJ${SECRET_CORE}.${"sG9n".repeat(8)}`,
  ghp: `ghp_${"Gh1p".repeat(9)}`,
  pg: `postgres://svc:${SECRET_CORE}@db.internal.test:5432/app`,
} as const;

function receivedSecrets(bodies: readonly string[]): string[] {
  const all = bodies.join("\n");
  return [SECRET_CORE, "Gh1pGh1p", "hD1rhD1r", "sG9nsG9n"].filter((fragment) =>
    all.includes(fragment),
  );
}

async function cspOf(baseUrl: string): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/`);
  return response.headers.get("content-security-policy") ?? undefined;
}

test.describe("AGO-104 AC1: error tracking is optional and adds nothing without a DSN", () => {
  test.skip(ingestPort !== 0, "this build has a browser DSN; run these on the normal build");

  test("AC1: with no DSN the page loads, no request leaves for any ingest and the CSP has no extra origin", async ({
    page,
    request,
  }) => {
    const ingest = await startFakeIngest();
    try {
      const requestedIngest: string[] = [];
      page.on("request", (req) => {
        if (req.url().startsWith(ingest.origin) || req.url().includes("/envelope")) {
          requestedIngest.push(req.url());
        }
      });

      await page.goto("/");
      // A synthetic window error: this is what Sentry's browser handler would capture if it were on.
      await page.evaluate(() => {
        window.dispatchEvent(new ErrorEvent("error", { error: new Error("injected, no dsn") }));
      });
      await page.waitForLoadState("networkidle");

      expect(requestedIngest).toEqual([]);
      expect(ingest.bodies).toEqual([]);
      const response = await request.get("/");
      const sources = connectSrc(response.headers()["content-security-policy"]);
      expect(sources).toContain("'self'");
      expect(sources.join(" ")).not.toMatch(/sentry|ingest/i);
    } finally {
      await ingest.close();
    }
  });

  test("AC1: a server started with SENTRY_DSN still serves pages, and a plain page load sends nothing (no tracing, no replay)", async ({
    request,
  }) => {
    const ingest = await startFakeIngest();
    let app: AppServer | undefined;
    try {
      app = await startAppServer({ SENTRY_DSN: ingest.dsn }, SERVER_READY);
      for (const path of ["/", "/sign-in", "/dev/ui"]) {
        const response = await request.get(`${app.baseUrl}${path}`);
        expect(response.status(), path).toBeLessThan(500);
      }
      // Unknown route: a 404 is not an error to report.
      expect((await request.get(`${app.baseUrl}/no-such-page`)).status()).toBe(404);
      expect(ingest.bodies).toEqual([]);
    } finally {
      await app?.stop();
      await ingest.close();
    }
  });
});

test.describe("AGO-104 AC1: a bad DSN fails fast without leaking it", () => {
  test("AC1 (negative): an invalid NEXT_PUBLIC_SENTRY_DSN refuses to serve and the log names the variable, not its value", async () => {
    const badValue = "not a url at all";
    let app: AppServer | undefined;
    try {
      app = await startAppServer({ NEXT_PUBLIC_SENTRY_DSN: badValue }, async (baseUrl) => {
        await fetch(`${baseUrl}/`);
        return true;
      });
      const response = await fetch(`${app.baseUrl}/`);
      expect(response.status).toBe(500);
      await expect.poll(() => app?.logs() ?? "").toContain("NEXT_PUBLIC_SENTRY_DSN");
      expect(app.logs()).not.toContain(badValue);
    } finally {
      await app?.stop();
    }
  });
});

test.describe("AGO-104 AC1: with a DSN in the build (needs the build described in the header)", () => {
  // Both tests listen on the one port the build was made with, so they must not overlap.
  test.describe.configure({ mode: "serial" });
  test.skip(
    ingestPort === 0,
    "needs a build made with NEXT_PUBLIC_SENTRY_DSN (see the header of this file)",
  );

  test("AC1: with a DSN the ingest origin joins connect-src, the key never does, script-src is untouched", async () => {
    const ingest = await startFakeIngest(ingestPort);
    let app: AppServer | undefined;
    try {
      app = await startAppServer({ NEXT_PUBLIC_SENTRY_DSN: ingest.dsn }, SERVER_READY);
      const csp = await cspOf(app.baseUrl);
      const sources = connectSrc(csp);

      expect(sources).toContain(ingest.origin);
      // Exactly one http origin beyond the Supabase one: no wildcard, no Sentry SaaS blanket.
      expect(
        sources.filter((source) => source.startsWith("http://") && source !== ingest.origin),
      ).toEqual(["http://127.0.0.1:54321"]);
      expect(sources).not.toContain("*");
      // The public key and the project path are never put in a header.
      expect(csp).not.toContain("publickey");
      expect(csp).not.toContain(`${ingest.origin}/1`);
      expect(csp).toContain("strict-dynamic");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    } finally {
      await app?.stop();
      await ingest.close();
    }
  });

  test("AC1: an injected browser error appears at the ingest, scrubbed, with no replay or tracing", async ({
    page,
  }) => {
    const ingest: FakeIngest = await startFakeIngest(ingestPort);
    let app: AppServer | undefined;
    try {
      app = await startAppServer(
        { SENTRY_DSN: ingest.dsn, NEXT_PUBLIC_SENTRY_DSN: ingest.dsn },
        SERVER_READY,
      );
      await page.goto(app.baseUrl);
      await page.evaluate((secrets) => {
        window.dispatchEvent(
          new ErrorEvent("error", {
            error: new Error(`browser injected failure ${Object.values(secrets).join(" | ")}`),
          }),
        );
      }, SECRETS);

      await expect
        .poll(() => errorEventsOf(ingest.bodies).length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(JSON.stringify(errorEventsOf(ingest.bodies))).toContain("browser injected failure");
      // AC2 in the browser: no secret fragment in any byte received.
      expect(receivedSecrets(ingest.bodies)).toEqual([]);
      // No Replay and no tracing envelopes (paid-plan features stay off).
      const everything = ingest.bodies.join("\n");
      expect(everything).not.toContain('"type":"replay_event"');
      expect(everything).not.toContain('"type":"replay_recording"');
      expect(everything).not.toContain('"type":"transaction"');
      expect(everything).not.toContain('"type":"profile"');
    } finally {
      await app?.stop();
      await ingest.close();
    }
  });
});
