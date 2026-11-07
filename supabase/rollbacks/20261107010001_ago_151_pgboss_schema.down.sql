-- Rollback for 20261107010001_ago_151_pgboss_schema.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping the schema deletes every queued, active and dead-lettered job: local data only. The runs
-- themselves stay in public.runs; re-enqueue them once the schema is back.
drop schema if exists pgboss cascade;
-- The function default-privilege entries live in pg_default_acl and are removed with the schema; the
-- worker's post-start hardening step is code and needs no rollback.
