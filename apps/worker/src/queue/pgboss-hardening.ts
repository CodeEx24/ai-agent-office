import type pg from "pg";

// pg-boss installs and upgrades its own functions inside the pgboss schema, and Postgres grants EXECUTE on
// new functions to PUBLIC by default. The schema is already closed to the API roles (no USAGE, see the
// AGO-151 migration); this removes the function grants as well so nothing relies on a single control.
// Idempotent and safe to run on every start from many workers at once: it only touches the pgboss schema,
// skips the revoke when nothing needs revoking, and serialises the revoke behind an advisory lock
// (concurrent REVOKEs on the same function ACLs fail with "tuple concurrently updated").
export const REVOKE_PGBOSS_FUNCTION_EXECUTE = `revoke execute on all functions in schema pgboss from public, anon, authenticated, service_role`;

// Fixed key for pg_advisory_xact_lock so every worker contends on the same lock.
export const PGBOSS_HARDENING_LOCK_KEY = 1_510_151_001;

// True when PUBLIC or an API role still holds EXECUTE on any function in the pgboss schema.
export const PGBOSS_EXECUTE_GRANTS_SQL = `
  select exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'pgboss'
       and a.privilege_type = 'EXECUTE'
       and (a.grantee = 0
            or a.grantee in (select oid from pg_roles
                              where rolname in ('anon', 'authenticated', 'service_role')))
  ) as has_grants`;

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;
// Bounds each statement and lock wait inside the hardening transaction, so a stalled lock or query
// ends the transaction (and frees its client) instead of hanging the start.
const ATTEMPT_LOCK_TIMEOUT = "5s";
const ATTEMPT_STATEMENT_TIMEOUT = "5s";

type Queryable = Pick<pg.PoolClient, "query">;
interface HardeningPool {
  connect(): Promise<pg.PoolClient>;
}

async function hasExecuteGrants(client: Queryable): Promise<boolean> {
  const { rows } = await client.query<{ has_grants: boolean }>(PGBOSS_EXECUTE_GRANTS_SQL);
  return rows[0]?.has_grants === true;
}

/** Upper bound on one attempt (connect, lock, probe, revoke). The caller's deadline can shorten it. */
const ATTEMPT_BUDGET_MS = 10_000;

/** The budget for one attempt: the attempt bound, or what is left before `deadline` (epoch ms). */
function attemptBudget(deadline: number): number {
  return Math.min(ATTEMPT_BUDGET_MS, Math.max(deadline - Date.now(), 0));
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Runs `work` on one pooled client within `budgetMs`. The client goes back to the pool only after a clean
 * finish. On a failure or a timeout it is released with an error, so pg destroys the connection instead of
 * pooling a half-used one. A client that arrives after the budget ended is released the same way.
 */
async function withPooledClient<T>(
  pool: HardeningPool,
  budgetMs: number,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const budgetEnded = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`pgboss hardening step timed out after ${String(budgetMs)} ms`));
    }, budgetMs);
  });
  const connecting = pool.connect();
  let client: pg.PoolClient | undefined;
  try {
    client = await Promise.race([connecting, budgetEnded]);
    const result = await Promise.race([work(client), budgetEnded]);
    client.release();
    return result;
  } catch (error) {
    const failure = toError(error);
    if (client === undefined) {
      connecting.then(
        (late) => {
          late.release(failure);
        },
        () => undefined,
      );
    } else {
      client.release(failure);
    }
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function hardenOnce(pool: HardeningPool, budgetMs: number): Promise<void> {
  await withPooledClient(pool, budgetMs, async (client) => {
    // Fast path: nothing to revoke, no lock and no ACL writes.
    if (!(await hasExecuteGrants(client))) return;
    await client.query("begin");
    try {
      await client.query(`set local lock_timeout = '${ATTEMPT_LOCK_TIMEOUT}'`);
      await client.query(`set local statement_timeout = '${ATTEMPT_STATEMENT_TIMEOUT}'`);
      await client.query("select pg_advisory_xact_lock($1)", [PGBOSS_HARDENING_LOCK_KEY]);
      // A concurrent worker may have finished the revoke while this one waited for the lock.
      if (await hasExecuteGrants(client)) await client.query(REVOKE_PGBOSS_FUNCTION_EXECUTE);
      await client.query("commit");
    } catch (error) {
      // If ROLLBACK fails the connection state is unknown. Throwing releases the client with an error.
      const rolledBack = await client.query("rollback").then(
        () => true,
        () => false,
      );
      throw rolledBack
        ? error
        : new Error("pgboss hardening rollback failed; connection discarded", { cause: error });
    }
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// How long a start waits for pg-boss background (bam) migrations to settle before it gives up.
export const DEFAULT_SETTLE_MAX_WAIT_MS = 60_000;
export const DEFAULT_SETTLE_POLL_MS = 250;

export interface SettleOptions {
  /** True once pg-boss has no background migration pending or running (any worker's). */
  readonly isSettled: () => Promise<boolean>;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
}

/** True when no pg-boss background migration is pending or in progress (rows of getBamStatus()). */
export function isBamSettled(rows: readonly { status: string }[]): boolean {
  return !rows.some((row) => row.status === "pending" || row.status === "in_progress");
}

async function verifyNoGrants(pool: HardeningPool, budgetMs: number): Promise<boolean> {
  return withPooledClient(pool, budgetMs, async (client) => !(await hasExecuteGrants(client)));
}

/** Rejects with a timeout error when `work` has not settled within `ms`. A hung await cannot outlive it. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function settleAttempt(
  pool: HardeningPool,
  options: SettleOptions,
  deadline: number,
): Promise<boolean> {
  const wasSettled = await options.isSettled();
  await hardenPgbossFunctions(pool, deadline);
  return wasSettled && (await verifyNoGrants(pool, attemptBudget(deadline)));
}

// pg-boss keeps creating functions after start() returns (background migrations, other workers'
// installs). A single revoke can therefore lose the race. This revokes, then confirms: it is done only
// when pg-boss was already settled BEFORE the revoke and a check AFTER it finds no PUBLIC/API-role
// EXECUTE. It waits at most maxWaitMs and then throws (fail closed): the caller must treat that as a
// startup error and never run unhardened. Residual risk: a function created after this returns keeps
// its default grant until the next worker restart. A running worker never re-hardens, so the window
// lasts as long as the worker runs. Only the schema-level revoke closes it (no USAGE for the API roles,
// AGO-151), so nothing reaches the function in that window.
export async function hardenPgbossFunctionsSettled(
  pool: HardeningPool,
  options: SettleOptions,
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SETTLE_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_SETTLE_POLL_MS;
  const deadline = Date.now() + maxWaitMs;
  let lastError: unknown;
  for (;;) {
    try {
      // Each attempt is raced against the budget that is left, so a stalled connect or query ends it.
      const budgetMs = Math.max(deadline - Date.now(), 0);
      if (
        await withTimeout(
          settleAttempt(pool, options, deadline),
          budgetMs,
          "pgboss hardening attempt",
        )
      ) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `pgboss function hardening did not settle within ${String(maxWaitMs)} ms; refusing to run unhardened`,
        lastError === undefined ? undefined : { cause: lastError },
      );
    }
    await sleep(pollMs);
  }
}

// A failure is never swallowed: it is retried a few times with jitter and then thrown, so the queue
// treats it as a startup error (and its own start retry runs) rather than running unhardened.
export async function hardenPgbossFunctions(
  pool: HardeningPool,
  deadline = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await hardenOnce(pool, attemptBudget(deadline));
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || Date.now() >= deadline) throw error;
      await sleep(BASE_DELAY_MS * attempt * (0.5 + Math.random()));
    }
  }
}
