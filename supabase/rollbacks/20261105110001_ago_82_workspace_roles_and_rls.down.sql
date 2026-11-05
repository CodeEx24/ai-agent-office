-- Rollback for 20261105110001_ago_82_workspace_roles_and_rls.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
drop function if exists public.onboard_current_user(text);
drop policy if exists members_select_member on public.members;
drop policy if exists workspaces_update_owner on public.workspaces;
drop policy if exists workspaces_select_member on public.workspaces;
revoke update (name) on public.workspaces from authenticated;
revoke select on public.workspaces, public.members from authenticated;
revoke usage on schema private from authenticated;
grant execute on function private.set_updated_at() to public;
drop function if exists private.is_member(uuid, text);
drop function if exists private.role_rank(text);
alter table public.members drop column if exists removed_at;
alter table public.members drop constraint if exists members_role_check;
comment on column public.members.role is 'Role name. Allowed values and enforcement arrive with AGO-82.';
