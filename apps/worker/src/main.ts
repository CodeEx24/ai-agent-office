import pg from "pg";

import { createProductionAgentExecutor } from "./agent/index.js";
import { loadWorkerConfig } from "./config.js";
import { createPgDatabaseCheck } from "./health.js";
import { createLogger, scrubString, type Logger } from "./logger.js";
import { createErrorTracker, type CreateErrorTrackerOptions, type ErrorTracker } from "./sentry.js";
import { createJobQueue, type JobQueue, type RunExecutor } from "./queue/index.js";
import { startHealthServer } from "./server.js";

import type { EnvSource } from "@ago/shared";
import type { Server } from "node:http";

export interface StartWorkerOptions {
  /** Tests inject a mock Sentry transport; production leaves this unset. */
  readonly sentryTransport?: CreateErrorTrackerOptions["transport"];
  /** The agent runtime (AGO-167). Absent: the queue accepts jobs but nothing consumes them. */
  readonly runExecutor?: RunExecutor;
  /** Queue base name; tests use a unique one so suites sharing a database stay isolated (AGO-202). */
  readonly queueName?: string;
}

export interface WorkerHandle {
  readonly server: Server;
  readonly logger: Logger;
  readonly errorTracker: ErrorTracker;
  readonly queue: JobQueue;
  stop(): Promise<void>;
}

/**
 * Start the worker, or report a fatal startup error as one JSON line and return null.
 * The logger needs a valid config, so a startup failure is written directly to `writeError`.
 */
export async function bootstrapWorker(
  source: EnvSource,
  writeError: (line: string) => void,
): Promise<WorkerHandle | null> {
  try {
    return await startWorker(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    writeError(JSON.stringify({ level: "fatal", service: "worker", msg: scrubString(message) }));
    return null;
  }
}

/**
 * Validate the environment, then start the health server. Throws on an invalid environment
 * (the caller exits non-zero); never logs secrets.
 */
export async function startWorker(
  source: EnvSource = process.env,
  options: StartWorkerOptions = {},
): Promise<WorkerHandle> {
  const config = loadWorkerConfig(source);
  const errorTracker = createErrorTracker({
    dsn: config.sentryDsn,
    environment: config.env.APP_ENV,
    transport: options.sentryTransport,
  });
  // Log lines double as breadcrumbs on later error events; stdout stays the shipped log stream.
  const logger = createLogger({
    level: config.logLevel,
    onLog: (entry) => {
      errorTracker.addBreadcrumb(entry);
    },
  });
  const db = createPgDatabaseCheck(config.databaseUrl, config.healthDbTimeoutMs);
  // The agent runtime reads runs, agents and skills; it gets its own small pool. No pool when a test
  // injects an executor or there is no model key.
  const agentPool =
    options.runExecutor === undefined && config.env.ANTHROPIC_API_KEY !== undefined
      ? new pg.Pool({ connectionString: config.databaseUrl, max: 4 })
      : undefined;
  agentPool?.on("error", () => undefined);
  const runExecutor =
    options.runExecutor ??
    (agentPool === undefined
      ? undefined
      : createProductionAgentExecutor({ config, pool: agentPool, logger }));
  const queue = createJobQueue({
    connectionString: config.databaseUrl,
    logger,
    errorTracker,
    executor: runExecutor,
    queueName: options.queueName,
    concurrency: config.queueConcurrency,
    shutdownTimeoutMs: config.queueShutdownTimeoutMs,
  });
  const server = await startHealthServer({
    port: config.port,
    host: config.host,
    logger,
    checks: { db, queue: () => queue.health() },
  });
  // Never throws: if the database is not up yet the queue keeps retrying and health reports it.
  void queue.start();
  logger.info({ app_env: config.env.APP_ENV, port: config.port }, "worker started");
  return {
    server,
    logger,
    errorTracker,
    queue,
    stop: async () => {
      // Drain first: running jobs finish (up to the timeout) while /health still answers.
      await queue.stop();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await db.close();
      await agentPool?.end().catch(() => undefined);
      logger.info("worker stopped");
      await errorTracker.close();
    },
  };
}
