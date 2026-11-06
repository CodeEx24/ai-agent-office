-- Rollback for 20261106130001_ago_96_department_hooks_policies.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Removing policies deletes its rows and the department_id columns lose their values: local data only.
drop policy if exists policies_update_owner on public.policies;
drop policy if exists policies_insert_owner on public.policies;
drop policy if exists policies_select_viewer on public.policies;
drop table if exists public.policies;
drop function if exists private.bump_policy_version();

drop index if exists public.notes_index_workspace_department_idx;
drop index if exists public.approvals_workspace_department_idx;
drop index if exists public.tasks_workspace_department_idx;
drop index if exists public.agents_workspace_department_idx;

alter table public.notes_index drop column if exists department_id;
alter table public.approvals drop column if exists department_id;
alter table public.tasks drop column if exists department_id;
alter table public.agents drop column if exists department_id;
