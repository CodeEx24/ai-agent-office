import { REDACTED, scrubString, scrubValue } from "@ago/shared";
import { pino, type Logger } from "pino";

export type { Logger } from "pino";

// Redaction lives in @ago/shared so the logger and error tracking (AGO-104) apply one rule set.
export { REDACTED, scrubString, scrubValue };

/** Context ids that every run-scoped log line carries. */
export interface LogContext {
  readonly run_id?: string;
  readonly agent_id?: string;
  readonly workspace_id?: string;
}

/** One scrubbed log call, offered to an optional sink such as Sentry breadcrumbs. */
export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly context: LogContext;
}

export interface CreateLoggerOptions {
  readonly level?: string;
  /** Destination stream; defaults to stdout. Tests pass a collector. */
  readonly destination?: { write(chunk: string): void };
  /** Called with every emitted (already scrubbed) entry; must not throw into the logger. */
  readonly onLog?: (entry: LogEntry) => void;
}

function readContext(bindings: Readonly<Record<string, unknown>>): LogContext {
  const pick = (key: keyof LogContext): string | undefined => {
    const value = bindings[key];
    return typeof value === "string" ? value : undefined;
  };
  return { run_id: pick("run_id"), agent_id: pick("agent_id"), workspace_id: pick("workspace_id") };
}

function messageOf(args: readonly unknown[]): string {
  const text = args.find((arg) => typeof arg === "string");
  return typeof text === "string" ? text : "";
}

/** Structured JSON logger (one object per line). Secrets and credentialed URLs are scrubbed. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { onLog } = options;
  return pino(
    {
      name: "ago-worker",
      level: options.level ?? "info",
      base: { service: "worker" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      hooks: {
        logMethod(args, method, levelNumber) {
          const scrubbed = args.map((arg) => scrubValue(arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
          if (onLog === undefined) return;
          try {
            onLog({
              level: this.levels.labels[levelNumber] ?? "info",
              message: messageOf(scrubbed),
              context: readContext(this.bindings()),
            });
          } catch {
            // A sink fault must never break logging.
          }
        },
      },
    },
    options.destination,
  );
}

/**
 * Child logger bound to the run / agent / workspace ids, so every line from a run is
 * attributable. Only ids that are present are bound.
 */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {};
  if (context.run_id !== undefined) bindings.run_id = context.run_id;
  if (context.agent_id !== undefined) bindings.agent_id = context.agent_id;
  if (context.workspace_id !== undefined) bindings.workspace_id = context.workspace_id;
  return logger.child(bindings);
}
