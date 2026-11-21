-- Rollback for 20261121020001_ago_117_goal_task_proposals.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Drops the suggested owner and dependency data; the proposed tasks stay as ordinary Inbox tasks.
drop function if exists public.create_goal_tasks(uuid, uuid, uuid, jsonb);
drop index if exists public.tasks_suggested_agent_idx;
alter table public.tasks
  drop constraint if exists tasks_depends_on_no_null,
  drop constraint if exists tasks_depends_on_not_self,
  drop constraint if exists tasks_depends_on_max,
  drop constraint if exists tasks_suggested_agent_fk;
alter table public.tasks
  drop column if exists depends_on_task_ids,
  drop column if exists suggested_agent_id;
