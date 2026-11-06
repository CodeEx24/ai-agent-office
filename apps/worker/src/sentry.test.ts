import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, withContext } from "./logger.js";
import { createErrorTracker, registerFatalErrorHandlers, type ErrorTracker } from "./sentry.js";

// Fake DSN on a reserved host: nothing here ever leaves the process (mock transport).
const DSN = "https://publickey@o0.ingest.sentry.example.test/1";

// Synthetic secret shapes assembled at runtime so no real-looking secret sits in the source.
const GHP = `ghp_${"a1B2".repeat(9)}`;
const SB_SECRET = `sb_secret_${"Zy9x".repeat(8)}`;
const SK_PROJ = `sk-proj-${"Qw3r".repeat(8)}`;
const JWT = `eyJ${"h".repeat(12)}.eyJ${"p".repeat(12)}.${"s".repeat(16)}`;
const BEARER = `Bearer ${"t0k3n".repeat(4)}`;

interface ExceptionPayload {
  readonly values: readonly { readonly value?: string }[];
}

type SentryEvent = Record<string, unknown> & {
  tags?: Record<string, string>;
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
};

function mockTransport() {
  const bodies: string[] = [];
  const transport: NonNullable<Sentry.NodeOptions["transport"]> = (options) =>
    Sentry.createTransport(options, (request) => {
      bodies.push(
        typeof request.body === "string" ? request.body : Buffer.from(request.body).toString(),
      );
      return Promise.resolve({ statusCode: 200 });
    });
  const events = (): SentryEvent[] =>
    bodies
      .flatMap((body) => body.split("\n"))
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as SentryEvent;
          return "exception" in parsed || "message" in parsed ? [parsed] : [];
        } catch {
          return [];
        }
      });
  return { bodies, events, transport };
}

let tracker: ErrorTracker | undefined;

afterEach(async () => {
  await tracker?.close();
  tracker = undefined;
});

describe("createErrorTracker with a DSN", () => {
  it("tags an injected error in a run context with run_id, agent_id and workspace_id", async () => {
    const { events, transport } = mockTransport();
    tracker = createErrorTracker({ dsn: DSN, environment: "local", transport });

    const id = tracker.captureException(new Error("injected failure"), {
      run_id: "run-42",
      agent_id: "agent-7",
      workspace_id: "ws-1",
    });
    await tracker.close();

    expect(id).toEqual(expect.any(String));
    const [event] = events();
    expect(event?.tags).toMatchObject({
      run_id: "run-42",
      agent_id: "agent-7",
      workspace_id: "ws-1",
      service: "worker",
    });
    expect(JSON.stringify(event)).toContain("injected failure");
  });

  it("does not leak a run's tags into the next error", async () => {
    const { events, transport } = mockTransport();
    tracker = createErrorTracker({ dsn: DSN, environment: "local", transport });

    tracker.captureException(new Error("first"), { run_id: "run-1" });
    tracker.captureException(new Error("second"));
    await tracker.close();

    // Match on the exception message: stack frames carry source lines that mention "second".
    const second = events().find(
      (event) => (event.exception as ExceptionPayload | undefined)?.values[0]?.value === "second",
    );
    expect(second).toBeDefined();
    expect(second?.tags?.run_id).toBeUndefined();
  });

  it("scrubs every secret shape from message, extra, request and breadcrumbs", async () => {
    const { bodies, events, transport } = mockTransport();
    tracker = createErrorTracker({ dsn: DSN, environment: "local", transport });
    const secrets = [GHP, SB_SECRET, SK_PROJ, JWT, BEARER, "hunter2", "p4ssw0rd", "ck-secret"];

    Sentry.addBreadcrumb({
      message: `breadcrumb ${GHP}`,
      data: { apiKey: "ck-secret", url: "postgres://u:hunter2@db/app" },
    });
    Sentry.withScope((scope) => {
      scope.setExtras({
        detail: `extra ${SB_SECRET}`,
        password: "p4ssw0rd",
        authorization: BEARER,
      });
      scope.setContext("call", { note: `ctx ${JWT}` });
      scope.addEventProcessor((event) => ({
        ...event,
        request: {
          url: `https://app.test/hook?access_token=${SK_PROJ}`,
          headers: { authorization: BEARER, cookie: "sid=abc" },
          data: { token: "ck-secret" },
        },
      }));
      Sentry.captureException(
        new Error(`failed for ${GHP} using ${BEARER} at postgres://u:hunter2@db/app`),
      );
    });
    await tracker.close();

    expect(events()).toHaveLength(1);
    const everything = bodies.join("\n");
    for (const secret of secrets) expect(everything).not.toContain(secret);
    expect(everything).toContain("[redacted]");
  });

  it("turns logger lines into scrubbed breadcrumbs carrying the run id", async () => {
    const { bodies, events, transport } = mockTransport();
    tracker = createErrorTracker({ dsn: DSN, environment: "local", transport });
    const logger = withContext(
      createLogger({
        destination: { write: () => undefined },
        onLog: (entry) => {
          tracker?.addBreadcrumb(entry);
        },
      }),
      { run_id: "run-9" },
    );

    logger.info(`calling with ${BEARER}`);
    tracker.captureException(new Error("after log"), { run_id: "run-9" });
    await tracker.close();

    const crumbs = events()[0]?.breadcrumbs ?? [];
    const logCrumb = crumbs.find((crumb) => crumb.message?.startsWith("calling with"));
    expect(logCrumb?.data).toMatchObject({ run_id: "run-9" });
    expect(bodies.join("\n")).not.toContain(BEARER);
  });

  it("collects no cookies, headers, query params or user data by default", () => {
    const { transport } = mockTransport();
    tracker = createErrorTracker({ dsn: DSN, environment: "local", transport });
    const options = Sentry.getClient()?.getOptions();

    expect(options?.tracesSampleRate).toBe(0);
    expect(options?.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
    });
  });
});

describe("createErrorTracker without a DSN", () => {
  it.each([undefined, ""])("is a no-op and never initialises Sentry (dsn=%j)", async (dsn) => {
    const { bodies, transport } = mockTransport();
    tracker = createErrorTracker({ dsn, environment: "local", transport });

    expect(tracker.isEnabled).toBe(false);
    expect(tracker.captureException(new Error("ignored"), { run_id: "run-1" })).toBeUndefined();
    tracker.addBreadcrumb({ level: "info", message: "x", context: {} });
    await expect(tracker.close()).resolves.toBe(true);

    // Sentry was never initialised, so there is no client that could have sent anything.
    expect(Sentry.isInitialized()).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    expect(bodies).toHaveLength(0);
  });
});

describe("registerFatalErrorHandlers", () => {
  function fakeProcess() {
    const listeners = new Map<string, (reason: unknown) => void>();
    const exit = vi.fn();
    return {
      listeners,
      exit,
      proc: {
        on: (event: string, listener: (reason: unknown) => void) => listeners.set(event, listener),
        exit,
      },
    };
  }

  it("reports an uncaught exception once, flushes, then exits 1", async () => {
    const fake = fakeProcess();
    const captureException = vi.fn();
    const close = vi.fn(() => Promise.resolve(true));
    const lines: string[] = [];
    const logger = createLogger({ destination: { write: (chunk) => void lines.push(chunk) } });
    registerFatalErrorHandlers(
      fake.proc,
      { isEnabled: true, captureException, addBreadcrumb: vi.fn(), close },
      logger,
    );

    const error = new Error(`boom ${GHP}`);
    fake.listeners.get("uncaughtException")?.(error);
    fake.listeners.get("unhandledRejection")?.(new Error("second"));
    await vi.waitFor(() => {
      expect(fake.exit).toHaveBeenCalledWith(1);
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.join("")).toContain("fatal");
    expect(lines.join("")).not.toContain(GHP);
  });
});
