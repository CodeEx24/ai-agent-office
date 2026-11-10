-- Rollback for 20261107140001_ago_166_agent_run_limits.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping the column loses stored per-agent run limits: local data only.
drop function if exists public.set_agent_run_limits(uuid, uuid, jsonb);
alter table public.agents drop column if exists run_limits;
drop function if exists private.run_limits_valid(jsonb);
