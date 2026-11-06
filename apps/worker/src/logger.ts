import { isSecretLikeEnvName } from "@ago/shared";
import { pino, type Logger } from "pino";

export type { Logger } from "pino";

export const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi;

/** Context ids that every run-scoped log line carries. */
export interface LogContext {
  readonly run_id?: string;
  readonly agent_id?: string;
  readonly workspace_id?: string;
}

/** Strip `scheme://user:password@` credentials out of any string. */
export function scrubString(value: string): string {
  return value.replace(CREDENTIAL_URL, `$1${REDACTED}@`);
}

function isSecretKey(key: string): boolean {
  return isSecretLikeEnvName(key.replace(/([a-z])([A-Z])/g, "$1_$2"));
}

/** Deep-copy a log payload, masking secret-named keys and credentialed URLs. Never mutates. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubString(value.message),
      stack: value.stack === undefined ? undefined : scrubString(value.stack),
    };
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

export interface CreateLoggerOptions {
  readonly level?: string;
  /** Destination stream; defaults to stdout. Tests pass a collector. */
  readonly destination?: { write(chunk: string): void };
}

/** Structured JSON logger (one object per line). Secrets and credentialed URLs are scrubbed. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      name: "ago-worker",
      level: options.level ?? "info",
      base: { service: "worker" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg) => scrubValue(arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
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
