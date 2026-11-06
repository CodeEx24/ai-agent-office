import { loadWorkerConfig } from "./config.js";
import { createPgDatabaseCheck, queueNotConfigured } from "./health.js";
import { createLogger, scrubString, type Logger } from "./logger.js";
import { startHealthServer } from "./server.js";

import type { EnvSource } from "@ago/shared";
import type { Server } from "node:http";

export interface WorkerHandle {
  readonly server: Server;
  readonly logger: Logger;
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
export async function startWorker(source: EnvSource = process.env): Promise<WorkerHandle> {
  const config = loadWorkerConfig(source);
  const logger = createLogger({ level: config.logLevel });
  const db = createPgDatabaseCheck(config.databaseUrl, config.healthDbTimeoutMs);
  const server = await startHealthServer({
    port: config.port,
    host: config.host,
    logger,
    checks: { db, queue: queueNotConfigured },
  });
  logger.info({ app_env: config.env.APP_ENV, port: config.port }, "worker started");
  return {
    server,
    logger,
    stop: async () => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await db.close();
      logger.info("worker stopped");
    },
  };
}
