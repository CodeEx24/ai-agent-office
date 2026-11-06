-- AGO-151: home of the pg-boss job queue.
-- The worker installs and upgrades pg-boss's own tables inside this schema (pg-boss versions its DDL
-- itself, so a hand-copied copy would drift). The migration only creates the schema and shuts it away:
-- it is not in supabase/config.toml `api.schemas`, so PostgREST never serves it, and the web roles
-- (anon, authenticated, service_role) get no usage and no default privileges. Only the owner role the
-- worker connects as (DATABASE_URL) can touch it. Jobs carry ids only: never secrets or prompts.
-- Rollback: supabase/rollbacks/20261107010001_ago_151_pgboss_schema.down.sql

create schema if not exists pgboss;
comment on schema pgboss is 'pg-boss job queue (AGO-151). Worker-owned; never exposed through the API.';

revoke all on schema pgboss from public;
revoke all on schema pgboss from anon, authenticated, service_role;

alter default privileges in schema pgboss revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema pgboss revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema pgboss revoke all on functions from public, anon, authenticated, service_role;

-- Defence in depth for functions. Postgres lets PUBLIC execute every new function by default, and
-- pg-boss creates functions (create_queue, job_table_run, ...) when the worker installs it. Schema USAGE is
-- already denied above, so the API roles cannot call them; this also removes the EXECUTE privilege itself.
-- Note: ALTER DEFAULT PRIVILEGES ... IN SCHEMA can only subtract entries recorded for that schema, it cannot
-- undo the built-in PUBLIC default, so it is not enough alone. The worker therefore re-runs the idempotent
-- `revoke execute on all functions in schema pgboss` after pg-boss starts (apps/worker/src/queue/pgboss-hardening.ts),
-- which is the step that covers functions pg-boss (re)creates during install or upgrade.
alter default privileges in schema pgboss revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema pgboss revoke execute on functions from public, anon, authenticated, service_role;
revoke execute on all functions in schema pgboss from public, anon, authenticated, service_role;
