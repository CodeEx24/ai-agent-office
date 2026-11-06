import pg from "pg";

export type ComponentStatus = "ok" | "down" | "not_configured";

export interface ComponentReport {
  readonly status: ComponentStatus;
}

/** A dependency probe. Must resolve (never throw) with the component's status. */
export type HealthCheck<R extends ComponentReport = ComponentReport> = () => Promise<R>;

/** Job counts for the run queue (AC3). Counts only: never job payloads. */
export interface QueueDepth {
  /** Waiting to run, including jobs waiting out a retry backoff. */
  readonly queued: number;
  readonly active: number;
  /** Failed jobs still retained in the queue table. */
  readonly failed: number;
  /** Jobs that failed every attempt and sit in the dead-letter queue. */
  readonly dead_letter: number;
}

export interface QueueReport extends ComponentReport {
  /** Present when the queue is `ok`. */
  readonly depth?: QueueDepth;
}

export interface HealthReport {
  /** ok: all parts up. degraded: queue not ready. down: database unreachable. */
  readonly status: "ok" | "degraded" | "down";
  readonly db: ComponentReport;
  readonly queue: QueueReport;
  readonly uptime_s: number;
}

export interface HealthChecks {
  readonly db: HealthCheck;
  /** pg-boss run queue (AGO-151): status plus depth. */
  readonly queue: HealthCheck<QueueReport>;
}

/** For callers that run without a queue (tests, tools): reports `not_configured`. */
export const queueNotConfigured: HealthCheck<QueueReport> = () =>
  Promise.resolve({ status: "not_configured" });

async function safely<R extends ComponentReport>(check: HealthCheck<R>, fallback: R): Promise<R> {
  try {
    return await check();
  } catch {
    return fallback;
  }
}

export function summarize(db: ComponentReport, queue: ComponentReport): HealthReport["status"] {
  if (db.status !== "ok") return "down";
  return queue.status === "ok" ? "ok" : "degraded";
}

export async function buildHealthReport(
  checks: HealthChecks,
  uptimeSeconds: number,
): Promise<HealthReport> {
  const [db, queue] = await Promise.all([
    safely<ComponentReport>(checks.db, { status: "down" }),
    safely<QueueReport>(checks.queue, { status: "down" }),
  ]);
  return { status: summarize(db, queue), db, queue, uptime_s: Math.round(uptimeSeconds) };
}

/** HTTP status for a report: only a database outage fails the probe (503). */
export function httpStatusFor(report: HealthReport): 200 | 503 {
  return report.status === "down" ? 503 : 200;
}

export type PgDatabaseCheck = HealthCheck & { close(): Promise<void> };

/** Cheap `select 1` against Postgres with a hard timeout. The pool is lazy: no connect at start. */
export function createPgDatabaseCheck(
  connectionString: string,
  timeoutMs: number,
): PgDatabaseCheck {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    idleTimeoutMillis: 10_000,
  });
  // An idle client error must not crash the process; the next probe reports it.
  pool.on("error", () => undefined);
  const check: HealthCheck = async () => {
    try {
      await pool.query("select 1");
      return { status: "ok" };
    } catch {
      return { status: "down" };
    }
  };
  return Object.assign(check, { close: () => pool.end() });
}
