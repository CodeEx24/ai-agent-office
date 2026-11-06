import { z } from "zod";

import { loadWorkerEnv } from "./env.js";

import type { EnvSource, WorkerEnv } from "@ago/shared";

/** Postgres of the shared local Supabase stack (supabase/config.toml, db port 44322). */
export const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:44322/postgres";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** Worker-only settings. Everything shared with the web app stays in `workerEnvSchema`. */
export const workerRuntimeSchema = z.object({
  WORKER_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65535).default(8787),
  ),
  /** Loopback by default; the container image sets 0.0.0.0. */
  WORKER_HOST: z.preprocess(emptyToUndefined, z.string().min(1).default("127.0.0.1")),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default("info")),
  HEALTH_DB_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(100).max(30_000).default(2_000),
  ),
  /** Run jobs this worker processes at once. */
  QUEUE_CONCURRENCY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(32).default(2),
  ),
  /** How long shutdown waits for running jobs before aborting them. */
  QUEUE_SHUTDOWN_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(300_000).default(25_000),
  ),
});

export interface WorkerConfig {
  readonly env: WorkerEnv;
  readonly port: number;
  readonly host: string;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly healthDbTimeoutMs: number;
  readonly queueConcurrency: number;
  readonly queueShutdownTimeoutMs: number;
  /** `SENTRY_DSN`; undefined keeps error tracking off (AGO-104). */
  readonly sentryDsn: string | undefined;
}

/**
 * Validate everything the worker needs at process start. Throws (naming the variable, never
 * the value) so the entrypoint can exit non-zero.
 */
export function loadWorkerConfig(source: EnvSource = process.env): WorkerConfig {
  const env = loadWorkerEnv(source);
  const parsed = workerRuntimeSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid worker configuration: ${names.join(", ")}`);
  }
  return {
    env,
    port: parsed.data.WORKER_PORT,
    host: parsed.data.WORKER_HOST,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    healthDbTimeoutMs: parsed.data.HEALTH_DB_TIMEOUT_MS,
    queueConcurrency: parsed.data.QUEUE_CONCURRENCY,
    queueShutdownTimeoutMs: parsed.data.QUEUE_SHUTDOWN_TIMEOUT_MS,
    sentryDsn: env.SENTRY_DSN,
  };
}
