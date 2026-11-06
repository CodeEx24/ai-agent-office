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
