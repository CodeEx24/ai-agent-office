-- Rollback for 20261120010001_ago_113_goals.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Drops the goals and their links to tasks; the Manager tasks themselves stay (their goal_id column goes).
drop function if exists public.submit_goal(uuid, text);
alter table public.tasks drop constraint if exists tasks_goal_fk;
drop index if exists public.tasks_workspace_goal_idx;
alter table public.tasks drop column if exists goal_id;
drop table if exists public.goals;
