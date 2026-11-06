import { TELEMETRY_DATA_COLLECTION, scrubTelemetryEvent } from "@ago/shared";
import * as Sentry from "@sentry/node";

import type { LogContext, LogEntry, Logger } from "./logger.js";

/** Longest the worker waits for queued events to leave before exiting. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * What the rest of the worker sees of error tracking. Sentry is optional (AGO-104): the disabled
 * tracker never touches the SDK, so with no DSN nothing is initialised, buffered or sent.
 */
export interface ErrorTracker {
  readonly isEnabled: boolean;
  /** Report an error; the run / agent / workspace ids become Sentry tags. Returns the event id. */
  captureException(error: unknown, context?: LogContext): string | undefined;
  /** Record a (scrubbed) log line as a breadcrumb on later events. */
  addBreadcrumb(entry: LogEntry): void;
  /** Flush pending events and shut the SDK down. Resolves false when the flush timed out. */
  close(timeoutMs?: number): Promise<boolean>;
}

export interface CreateErrorTrackerOptions {
  /** `SENTRY_DSN`; undefined or empty disables error tracking entirely. */
  readonly dsn: string | undefined;
  /** `APP_ENV`, used as the Sentry environment. */
  readonly environment: string;
  /** Tests inject a mock transport; production uses Sentry's HTTP transport. */
  readonly transport?: Sentry.NodeOptions["transport"];
}

const DISABLED_TRACKER: ErrorTracker = {
  isEnabled: false,
  captureException: () => undefined,
  addBreadcrumb: () => undefined,
  close: () => Promise.resolve(true),
};

const BREADCRUMB_LEVELS: Readonly<Record<string, Sentry.SeverityLevel>> = {
  fatal: "fatal",
  error: "error",
  warn: "warning",
  info: "info",
};

/** The process-level handlers are ours (log, report, flush, exit 1), so Sentry's are removed. */
const OWN_FATAL_HANDLER_INTEGRATIONS = new Set(["OnUncaughtException", "OnUnhandledRejection"]);

/**
 * Create the worker's error tracker. Free-plan safe by construction: no tracing, no profiling,
 * no local variables, no PII. Every event and breadcrumb is scrubbed with the shared redactor
 * (the same rules as the log scrubber) before it leaves the process.
 */
export function createErrorTracker(options: CreateErrorTrackerOptions): ErrorTracker {
  if (options.dsn === undefined || options.dsn === "") return DISABLED_TRACKER;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    // Sentry v11 has no `sendDefaultPii`; `dataCollection` is the PII switch and defaults to on.
    dataCollection: TELEMETRY_DATA_COLLECTION,
    tracesSampleRate: 0,
    includeLocalVariables: false,
    initialScope: { tags: { service: "worker" } },
    integrations: (defaults) =>
      defaults.filter((integration) => !OWN_FATAL_HANDLER_INTEGRATIONS.has(integration.name)),
    beforeSend: (event) => scrubTelemetryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubTelemetryEvent(breadcrumb),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });

  return {
    isEnabled: true,
    captureException(error, context = {}) {
      return Sentry.withScope((scope) => {
        const tags: Record<string, string> = {};
        if (context.run_id !== undefined) tags.run_id = context.run_id;
        if (context.agent_id !== undefined) tags.agent_id = context.agent_id;
        if (context.workspace_id !== undefined) tags.workspace_id = context.workspace_id;
        scope.setTags(tags);
        return Sentry.captureException(error);
      });
    },
    addBreadcrumb(entry) {
      Sentry.addBreadcrumb({
        category: "log",
        level: BREADCRUMB_LEVELS[entry.level] ?? "debug",
        message: entry.message,
        data: { ...entry.context },
      });
    },
    async close(timeoutMs = FLUSH_TIMEOUT_MS) {
      return Sentry.close(timeoutMs);
    },
  };
}

/** The subset of `process` the fatal handlers use, so tests can pass a stand-in. */
export interface FatalErrorProcess {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (reason: unknown) => void,
  ): unknown;
  exit(code: number): unknown;
}

/**
 * Report uncaught exceptions and unhandled rejections: log one fatal line, send the error to
 * error tracking, flush, then exit non-zero (the supervisor restarts the worker). Runs once.
 */
export function registerFatalErrorHandlers(
  proc: FatalErrorProcess,
  tracker: ErrorTracker,
  logger: Logger,
): void {
  let isHandling = false;
  const handle = (kind: string) => (reason: unknown) => {
    if (isHandling) return;
    isHandling = true;
    logger.fatal({ err: reason, kind }, "fatal error, exiting");
    tracker.captureException(reason);
    tracker.close().then(
      () => proc.exit(1),
      () => proc.exit(1),
    );
  };
  proc.on("uncaughtException", handle("uncaughtException"));
  proc.on("unhandledRejection", handle("unhandledRejection"));
}
