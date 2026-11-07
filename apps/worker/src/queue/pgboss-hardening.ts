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

type Queryable = Pick<pg.PoolClient, "query">;
interface HardeningPool {
  connect(): Promise<pg.PoolClient>;
}

async function hasExecuteGrants(client: Queryable): Promise<boolean> {
  const { rows } = await client.query<{ has_grants: boolean }>(PGBOSS_EXECUTE_GRANTS_SQL);
  return rows[0]?.has_grants === true;
}

async function hardenOnce(pool: HardeningPool): Promise<void> {
  const client = await pool.connect();
  try {
    // Fast path: nothing to revoke, no lock and no ACL writes.
    if (!(await hasExecuteGrants(client))) return;
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [PGBOSS_HARDENING_LOCK_KEY]);
      // A concurrent worker may have finished the revoke while this one waited for the lock.
      if (await hasExecuteGrants(client)) await client.query(REVOKE_PGBOSS_FUNCTION_EXECUTE);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A failure is never swallowed: it is retried a few times with jitter and then thrown, so the queue
// treats it as a startup error (and its own start retry runs) rather than running unhardened.
export async function hardenPgbossFunctions(pool: HardeningPool): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await hardenOnce(pool);
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(BASE_DELAY_MS * attempt * (0.5 + Math.random()));
    }
  }
}
