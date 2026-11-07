import { DEFAULT_CONTEXT_MAX_CHARS } from "@ago/shared";
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
  /** Model for agent runs until per-agent routing (AGO-94) exists. */
  AGENT_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().min(1).max(100).default("claude-sonnet-5-5"),
  ),
  /** Run limits (AGO-167): a run stops with `run.limit_reached` at the first one it hits. */
  AGENT_MAX_STEPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(200).default(25),
  ),
  AGENT_MAX_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1_000).max(5_000_000).default(200_000),
  ),
  /** Under the job expiry (900 s) so the loop stops itself before pg-boss gives up on the job. */
  AGENT_MAX_WALL_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1_000).max(840_000).default(600_000),
  ),
  /** Cap on one built context, in characters (about 4 per token). */
  CONTEXT_MAX_CHARS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1_000).max(2_000_000).default(DEFAULT_CONTEXT_MAX_CHARS),
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
  readonly agentModel: string;
  readonly agentMaxSteps: number;
  readonly agentMaxTokens: number;
  readonly agentMaxWallMs: number;
  readonly contextMaxChars: number;
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
    agentModel: parsed.data.AGENT_MODEL,
    agentMaxSteps: parsed.data.AGENT_MAX_STEPS,
    agentMaxTokens: parsed.data.AGENT_MAX_TOKENS,
    agentMaxWallMs: parsed.data.AGENT_MAX_WALL_MS,
    contextMaxChars: parsed.data.CONTEXT_MAX_CHARS,
  };
}
