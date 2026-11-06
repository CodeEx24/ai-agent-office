import type pg from "pg";

// pg-boss installs and upgrades its own functions inside the pgboss schema, and Postgres grants EXECUTE on
// new functions to PUBLIC by default. The schema is already closed to the API roles (no USAGE, see the
// AGO-151 migration); this removes the function grants as well so nothing relies on a single control.
// Idempotent: safe to run on every start, and it only touches the pgboss schema.
export const REVOKE_PGBOSS_FUNCTION_EXECUTE = `revoke execute on all functions in schema pgboss from public, anon, authenticated, service_role`;

export async function hardenPgbossFunctions(pool: Pick<pg.Pool, "query">): Promise<void> {
  await pool.query(REVOKE_PGBOSS_FUNCTION_EXECUTE);
}
