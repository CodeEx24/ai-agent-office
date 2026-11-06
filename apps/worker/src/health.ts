import pg from "pg";

export type ComponentStatus = "ok" | "down" | "not_configured";

export interface ComponentReport {
  readonly status: ComponentStatus;
}

/** A dependency probe. Must resolve (never throw) with the component's status. */
export type HealthCheck = () => Promise<ComponentReport>;

export interface HealthReport {
  /** ok: all configured parts up. degraded: queue not configured. down: database unreachable. */
  readonly status: "ok" | "degraded" | "down";
  readonly db: ComponentReport;
  readonly queue: ComponentReport;
  readonly uptime_s: number;
}

export interface HealthChecks {
  readonly db: HealthCheck;
  /** pg-boss arrives with AGO-151; until then the queue reports `not_configured`. */
  readonly queue: HealthCheck;
}

/** Queue probe used until AGO-151 wires pg-boss: AGO-151 replaces this with a real check. */
export const queueNotConfigured: HealthCheck = () => Promise.resolve({ status: "not_configured" });

async function safely(check: HealthCheck): Promise<ComponentReport> {
  try {
    return await check();
  } catch {
    return { status: "down" };
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
  const [db, queue] = await Promise.all([safely(checks.db), safely(checks.queue)]);
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
