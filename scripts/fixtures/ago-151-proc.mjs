// AGO-151 QA fixture: a small process the acceptance tests spawn (and the Docker test mounts).
// It drives the BUILT worker (`apps/worker/dist`, or AGO_WORKER_DIST) and never reads a .env file.
//
//   ROLE=consumer  createJobQueue with a fake executor + short retry policy, handles SIGTERM like index.ts
//   ROLE=enqueuer  createJobQueue without an executor; enqueues ENQUEUE_JOBS (JSON) and prints the results
//   ROLE=worker    startWorker (real health server) with the same fake executor; SIGTERM wired like index.ts
//
// Fake executor (env): QA_EXEC_LOG (file; one JSON line per attempt), QA_EXEC_MS (work time),
// QA_FAIL_MESSAGE (always throw this), QA_HANG=1 (run until the job signal aborts).
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = process.env.AGO_WORKER_DIST
  ? pathToFileURL(`${process.env.AGO_WORKER_DIST.split(String.fromCharCode(92)).join("/").replace(/\/?$/, "/")}`)
  : new URL("../../apps/worker/dist/", import.meta.url);
const load = (path) => import(new URL(path, dist).href);

const role = process.env.ROLE;
const { createLogger } = await load("logger.js");
const { createErrorTracker } = await load("sentry.js");
const { createJobQueue } = await load("queue/index.js");

const record = (entry) => {
  if (process.env.QA_EXEC_LOG) appendFileSync(process.env.QA_EXEC_LOG, `${JSON.stringify(entry)}\n`);
};

const executor = {
  async execute(ctx) {
    const base = { run_id: ctx.runId, attempt: ctx.attempt, pid: process.pid };
    record({ ...base, event: "start", at: Date.now() });
    if (process.env.QA_FAIL_MESSAGE) {
      throw new Error(process.env.QA_FAIL_MESSAGE);
    }
    if (process.env.QA_HANG === "1") {
      await new Promise((resolve) => {
        if (ctx.signal.aborted) resolve();
        ctx.signal.addEventListener("abort", resolve, { once: true });
      });
      record({ ...base, event: "aborted", at: Date.now() });
      throw new Error("aborted by shutdown");
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.QA_EXEC_MS ?? 0)));
    record({ ...base, event: "done", at: Date.now() });
    return { steps: 1 };
  },
};

const transport = process.env.QA_SENTRY_FILE
  ? () => ({
      send: (envelope) => {
        appendFileSync(process.env.QA_SENTRY_FILE, `${JSON.stringify(envelope)}\n`);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    })
  : undefined;
const policy = {
  retryLimit: Number(process.env.QA_RETRY_LIMIT ?? 4),
  retryDelaySeconds: Number(process.env.QA_RETRY_DELAY ?? 5),
  retryDelayMaxSeconds: Number(process.env.QA_RETRY_MAX ?? 300),
  expireInSeconds: Number(process.env.QA_EXPIRE ?? 900),
};

function wireSignals(stop) {
  const shutdown = (signal) => {
    console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// QA_START_AT: a start barrier so several processes begin pg-boss start (and its hardening) at the same instant.
const startAt = Number(process.env.QA_START_AT ?? 0);
if (startAt > Date.now()) await new Promise((r) => setTimeout(r, startAt - Date.now()));

if (role === "worker") {
  const { startWorker } = await load("main.js");
  const handle = await startWorker(process.env, {
    runExecutor: process.env.QA_NO_EXECUTOR === "1" ? undefined : executor,
    sentryTransport: transport,
  });
  wireSignals(() => handle.stop());
  console.log("QA_READY");
} else {
  const errorTracker = createErrorTracker({
    dsn: transport ? "https://public@o0.ingest.sentry.io/1" : undefined,
    environment: "qa",
    transport,
  });
  const queue = createJobQueue({
    connectionString: process.env.DATABASE_URL,
    logger: createLogger({ level: "info" }),
    errorTracker,
    executor: role === "consumer" ? executor : undefined,
    retryPolicy: policy,
    pollingIntervalSeconds: 0.5,
    shutdownTimeoutMs: Number(process.env.QUEUE_SHUTDOWN_TIMEOUT_MS ?? 10_000),
    concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 2),
  });
  await queue.start();
  if (role === "enqueuer") {
    const results = [];
    // A start barrier so several enqueuers hit the queue at the same moment.
    const startAt = Number(process.env.ENQUEUE_AT ?? 0);
    if (startAt > Date.now()) await new Promise((r) => setTimeout(r, startAt - Date.now()));
    for (const job of JSON.parse(process.env.ENQUEUE_JOBS ?? "[]")) {
      try {
        const out = await queue.enqueueRun(job);
        results.push({ ok: true, ...out });
      } catch (error) {
        results.push({ ok: false, error: error?.name ?? "Error", message: String(error?.message) });
      }
    }
    console.log(`QA_RESULT ${JSON.stringify(results)}`);
    await errorTracker.close();
    await queue.stop();
    process.exit(0);
  }
  wireSignals(async () => {
    await queue.stop();
    await errorTracker.close();
  });
  console.log("QA_READY");
}
if (process.env.QA_PIDFILE) writeFileSync(process.env.QA_PIDFILE, String(process.pid));
