import { bootstrapWorker } from "./main.js";

/** Process entrypoint: fail fast with a non-zero exit when the environment is invalid. */
async function run(): Promise<void> {
  const worker = await bootstrapWorker(process.env, (line) => {
    console.error(line);
  });
  if (worker === null) {
    process.exit(1);
  }

  const shutdown = (signal: string): void => {
    worker.logger.info({ signal }, "shutting down");
    worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
}

void run();
