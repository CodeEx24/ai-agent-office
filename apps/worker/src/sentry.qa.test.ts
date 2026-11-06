import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, withContext } from "./logger.js";
import { startWorker, type WorkerHandle } from "./main.js";
import { createErrorTracker, type ErrorTracker } from "./sentry.js";

// AGO-104 QA: acceptance criteria proven against a LOCAL fake Sentry ingest over the real HTTP
// transport (no mock transport). Nothing leaves the machine. The real-Sentry check stays
// "pending owner DSN" until a DSN exists. Secret values are built at runtime so no secret-shaped
// literal sits in the source (gitleaks).

/** Distinct secret cores, so a leak is detectable by a plain substring search. */
const CORES = {
  bearer: "Tk9".repeat(8),
  apikey: `${"Ak3".repeat(9)}Zq`,
  jwtPayload: `eyJ${"payLoad".repeat(4)}`,
  jwtSig: "sIg9".repeat(10),
  sk: "Sk7q".repeat(12),
  skAnt: "An7t".repeat(8),
  sbSecret: "Sb5x".repeat(8),
  ghp: "Gh1p".repeat(9),
  pgPassword: "Pg8w".repeat(5),
  cookie: "Ck4e".repeat(8),
} as const;

const JWT = `eyJ${"hDr1".repeat(5)}.${CORES.jwtPayload}.${CORES.jwtSig}`;
const SECRET_TEXTS = {
  bearer: `Authorization: Bearer ${CORES.bearer}`,
  apikey: `https://api.example.test/v1/things?apikey=${CORES.apikey}&page=2`,
  jwt: `supabase session ${JWT}`,
  sk: `key sk-${CORES.sk}`,
  skAnt: `key sk-ant-api03-${CORES.skAnt}`,
  sbSecret: `key sb_secret_${CORES.sbSecret}`,
  ghp: `token ghp_${CORES.ghp}`,
  pgUrl: `connect postgres://worker_user:${CORES.pgPassword}@db.internal.test:5432/agoffice`,
} as const;

/** Every secret fragment that must never appear in any byte sent to the ingest. */
const FORBIDDEN_FRAGMENTS = Object.values(CORES);

interface FakeIngest {
  readonly dsn: string;
  readonly bodies: string[];
  readonly urls: string[];
  close(): Promise<void>;
  waitFor(predicate: (bodies: string[]) => boolean, timeoutMs?: number): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve(
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8"),
      );
    });
    request.on("error", reject);
  });
}

async function startFakeIngest(): Promise<FakeIngest> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const server: Server = createServer((request, response) => {
    readBody(request).then(
      (body) => {
        urls.push(request.url ?? "");
        bodies.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      () => {
        response.writeHead(400);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    dsn: `http://publickey@127.0.0.1:${String(port)}/1`,
    bodies,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(bodies)) {
        if (Date.now() > deadline) throw new Error("fake ingest: timed out waiting for envelopes");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

type SentryEvent = Record<string, unknown> & { tags?: Record<string, string> };

function eventsOf(bodies: readonly string[]): SentryEvent[] {
  return bodies
    .flatMap((body) => body.split("\n"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as SentryEvent;
        return "exception" in parsed || "message" in parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

const WORKER_ENV = {
  NODE_ENV: "test",
  WORKER_PORT: "0",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
  HEALTH_DB_TIMEOUT_MS: "300",
} as const;

let ingest: FakeIngest | undefined;
let tracker: ErrorTracker | undefined;
let worker: WorkerHandle | undefined;

afterEach(async () => {
  // Breadcrumbs live on Sentry's global scopes and would otherwise ride along into the next test's
  // events, so one leaking shape would make later, clean shapes look like leaks too.
  Sentry.getIsolationScope().clearBreadcrumbs();
  Sentry.getCurrentScope().clearBreadcrumbs();
  await tracker?.close();
  await worker?.stop();
  await ingest?.close();
  tracker = undefined;
  worker = undefined;
  ingest = undefined;
});

describe("AC1: an injected error appears in Sentry with run ID (local fake ingest, real transport)", () => {
  it("AC1: an error injected in a run context reaches the ingest tagged run_id, agent_id, workspace_id", async () => {
    ingest = await startFakeIngest();
    tracker = createErrorTracker({ dsn: ingest.dsn, environment: "local" });
    const ids = { run_id: "run_qa_0001", agent_id: "agent_qa_0001", workspace_id: "ws_qa_0001" };

    const eventId = tracker.captureException(new Error("injected failure in run"), ids);
    expect(eventId).toMatch(/^[0-9a-f]{32}$/);
    await tracker.close();
    tracker = undefined;

    await ingest.waitFor((bodies) => eventsOf(bodies).length > 0);
    expect(ingest.urls.some((url) => url.includes("/api/1/envelope"))).toBe(true);
    const [event] = eventsOf(ingest.bodies);
    expect(event?.tags).toMatchObject({ ...ids, service: "worker" });
    expect(event?.environment).toBe("local");
    expect(JSON.stringify(event)).toContain("injected failure in run");
  });

  it("AC1: the next error without a run context does not inherit the previous run's tags", async () => {
    ingest = await startFakeIngest();
    tracker = createErrorTracker({ dsn: ingest.dsn, environment: "local" });
    tracker.captureException(new Error("first with run"), { run_id: "run_qa_leaky" });
    tracker.captureException(new Error("second without run"));
    await tracker.close();
    tracker = undefined;

    await ingest.waitFor((bodies) => eventsOf(bodies).length >= 2);
    // Match on the exception value: stack frames carry source context that quotes this very line.
    const second = eventsOf(ingest.bodies).find((e) =>
      (e.exception as { values: { value?: string }[] }).values.some(
        (v) => v.value === "second without run",
      ),
    );
    expect(second).toBeDefined();
    expect(second?.tags?.run_id).toBeUndefined();
  });

  it("AC1: the real worker (SENTRY_DSN in its env) ships an error with the run id it was given", async () => {
    ingest = await startFakeIngest();
    worker = await startWorker({ ...WORKER_ENV, SENTRY_DSN: ingest.dsn });
    expect(worker.errorTracker.isEnabled).toBe(true);
    worker.errorTracker.captureException(new Error("worker run exploded"), {
      run_id: "run_qa_worker",
      workspace_id: "ws_qa_worker",
    });
    await worker.errorTracker.close();

    await ingest.waitFor((bodies) => eventsOf(bodies).length > 0);
    expect(eventsOf(ingest.bodies)[0]?.tags).toMatchObject({
      run_id: "run_qa_worker",
      workspace_id: "ws_qa_worker",
    });
  });
});

describe("AC1 (negative): without a DSN nothing is sent and nothing crashes", () => {
  it("AC1: no SENTRY_DSN means a disabled tracker and zero requests to any ingest", async () => {
    ingest = await startFakeIngest();
    worker = await startWorker({ ...WORKER_ENV });
    expect(worker.errorTracker.isEnabled).toBe(false);
    expect(
      worker.errorTracker.captureException(new Error("nobody hears this"), { run_id: "run_x" }),
    ).toBeUndefined();
    await worker.errorTracker.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ingest.bodies).toEqual([]);
  });

  it("AC1: an empty SENTRY_DSN behaves like no DSN", async () => {
    ingest = await startFakeIngest();
    worker = await startWorker({ ...WORKER_ENV, SENTRY_DSN: "" });
    expect(worker.errorTracker.isEnabled).toBe(false);
  });
});

describe("AC2: secrets are scrubbed from error payloads (every byte sent to the ingest)", () => {
  it("AC2: no secret shape appears anywhere in the envelopes: message, exception, cause, extra, contexts, request, breadcrumbs", async () => {
    ingest = await startFakeIngest();
    tracker = createErrorTracker({ dsn: ingest.dsn, environment: "local" });
    const base = createLogger({
      level: "info",
      onLog: (entry) => {
        tracker?.addBreadcrumb(entry);
      },
    });
    const log = withContext(base, { run_id: "run_qa_secrets", workspace_id: "ws_qa" });

    // Breadcrumbs: secrets in log message text and in log fields.
    log.info(
      { headers: { authorization: `Bearer ${CORES.bearer}`, cookie: `sb=${CORES.cookie}` } },
      SECRET_TEXTS.bearer,
    );
    log.warn({ url: SECRET_TEXTS.apikey, password: CORES.pgPassword }, SECRET_TEXTS.pgUrl);

    // Exception message + cause carrying every shape.
    const error = new Error(Object.values(SECRET_TEXTS).join(" | "), {
      cause: new Error(`inner ${SECRET_TEXTS.sk} ${SECRET_TEXTS.ghp}`),
    });
    Object.assign(error, { token: CORES.sk, headers: { cookie: `sb=${CORES.cookie}` } });

    Sentry.withScope((scope) => {
      scope.setTags({ run_id: "run_qa_secrets" });
      scope.setExtras({
        apiKey: CORES.apikey,
        url: SECRET_TEXTS.apikey,
        note: SECRET_TEXTS.skAnt,
        nested: { sb: SECRET_TEXTS.sbSecret, password: CORES.pgPassword },
      });
      scope.setContext("db", { connection: SECRET_TEXTS.pgUrl, secret: CORES.pgPassword });
      scope.setContext("auth", { jwt: SECRET_TEXTS.jwt });
      Sentry.captureException(error);
    });
    // An event that carries a request object directly (what a server SDK builds).
    Sentry.captureEvent({
      message: SECRET_TEXTS.bearer,
      request: {
        url: `https://app.example.test/x?apikey=${CORES.apikey}`,
        headers: { Authorization: `Bearer ${CORES.bearer}`, Cookie: `sb=${CORES.cookie}` },
        cookies: { sb: CORES.cookie },
        query_string: `apikey=${CORES.apikey}&token=${CORES.bearer}`,
      },
    });
    await tracker.close();
    tracker = undefined;

    await ingest.waitFor((bodies) => eventsOf(bodies).length >= 2);
    const everything = ingest.bodies.join("\n");
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      expect(everything, `a secret fragment (${fragment.slice(0, 4)}...) leaked`).not.toContain(
        fragment,
      );
    }
    // The scrubber must not erase the whole event: the run id tag survives and redaction marks show.
    const event = eventsOf(ingest.bodies).find((e) => e.tags?.run_id === "run_qa_secrets");
    expect(event?.tags?.run_id).toBe("run_qa_secrets");
    expect(everything).toContain("[redacted]");
  });
});

// Further shapes probed during QA (AGO-104 AC2). Each is its own test so a failure names the shape.
describe("AC2: further secret shapes must not reach the ingest", () => {
  const BODY = "Zk4m".repeat(12);
  const SHORT_BODY = "Zk4m".repeat(8);
  const shapes: readonly (readonly [string, string, string])[] = [
    ["OpenAI service-account key (sk-svcacct-)", `key sk-svcacct-${BODY}`, BODY],
    ["OpenAI admin key (sk-admin-)", `key sk-admin-${BODY}`, BODY],
    ["plain sk- key shorter than 48 characters", `key sk-${SHORT_BODY}`, SHORT_BODY],
    ["Set-Cookie header written into free text", `Set-Cookie: session=${BODY}; Path=/`, BODY],
    [
      "sk- key containing dots and underscores (up to the dot)",
      `key sk-${BODY.slice(0, 20)}.${BODY.slice(20, 30)}_${BODY.slice(30)}`,
      BODY.slice(0, 20),
    ],
    [
      "sk-proj- key with an underscore",
      `key sk-proj-${BODY.slice(0, 24)}_${BODY.slice(24)}`,
      BODY.slice(24),
    ],
    [
      "Authorization: Basic header",
      `Authorization: Basic ${Buffer.from(`svc:${BODY}`).toString("base64")}`,
      Buffer.from(`svc:${BODY}`).toString("base64").slice(0, 24),
    ],
    ["x-api-key header in free text", `request failed x-api-key: ${BODY} status=500`, BODY],
    ["X-Api-Key header written with =", `X-Api-Key=${BODY}`, BODY],
    [
      "access_token in a URL query",
      `GET https://api.example.test/cb?access_token=${BODY}&x=1`,
      BODY,
    ],
    [
      "access_token in a URL fragment",
      `redirect https://app.example.test/cb#access_token=${BODY}&type=bearer`,
      BODY,
    ],
    [
      "Supabase sb_secret_ key with an underscore",
      `key sb_secret_${BODY.slice(0, 20)}_${BODY.slice(20)}`,
      BODY.slice(20),
    ],
    ["Cookie request header in free text", `Cookie: sb-access-token=${BODY}; theme=dark`, BODY],
  ];

  for (const [label, text, fragment] of shapes) {
    it(`AC2: ${label} is scrubbed from the error message and a breadcrumb`, async () => {
      ingest = await startFakeIngest();
      tracker = createErrorTracker({ dsn: ingest.dsn, environment: "local" });
      tracker.addBreadcrumb({
        level: "info",
        message: text,
        context: {},
      });
      tracker.captureException(new Error(text));
      await tracker.close();
      tracker = undefined;

      await ingest.waitFor((bodies) => eventsOf(bodies).length > 0);
      expect(ingest.bodies.join("\n")).not.toContain(fragment);
    });
  }
});
