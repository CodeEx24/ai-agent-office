-- Rollback for 20261120020001_ago_81_agent_handoffs.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Drops the handoff columns, so the chain, requester and narrowed grants of every handoff are lost; the handoff
-- tasks themselves stay as ordinary tasks assigned to their receivers.
drop function if exists public.accept_handoff_task(uuid, uuid, uuid);
drop function if exists public.create_handoff_task(uuid, uuid, uuid, uuid, text, text, uuid, uuid[], integer, jsonb);
drop index if exists public.tasks_requester_member_idx;
drop index if exists public.tasks_handoff_from_agent_idx;
drop index if exists public.tasks_handoff_run_unique;
drop index if exists public.tasks_workspace_parent_idx;
alter table public.tasks
  drop constraint if exists tasks_handoff_run_fk,
  drop constraint if exists tasks_handoff_requester_fk,
  drop constraint if exists tasks_handoff_from_agent_fk,
  drop constraint if exists tasks_handoff_parent_fk,
  drop constraint if exists tasks_handoff_grants_shape,
  drop constraint if exists tasks_handoff_path_shape,
  drop constraint if exists tasks_handoff_depth_range,
  drop constraint if exists tasks_handoff_all_or_none;
alter table public.tasks
  drop column if exists handoff_run_id,
  drop column if exists handoff_grants,
  drop column if exists handoff_path,
  drop column if exists handoff_depth,
  drop column if exists requester_member_id,
  drop column if exists handoff_from_agent_id,
  drop column if exists parent_task_id;
