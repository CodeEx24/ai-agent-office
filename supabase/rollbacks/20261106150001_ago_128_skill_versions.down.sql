-- Rollback for 20261106150001_ago_128_skill_versions.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
-- Dropping skill_versions deletes the version history (the current text stays in skills): local data only.
drop policy if exists agent_skills_delete_owner on public.agent_skills;
drop policy if exists agent_skills_insert_owner on public.agent_skills;
create policy agent_skills_insert_member on public.agent_skills for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy agent_skills_delete_member on public.agent_skills for delete to authenticated
  using (private.is_member(workspace_id, 'member'));

drop policy if exists skills_update_owner on public.skills;
drop policy if exists skills_insert_owner on public.skills;
create policy skills_insert_member on public.skills for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy skills_update_member on public.skills for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
create policy skills_delete_member on public.skills for delete to authenticated
  using (private.is_member(workspace_id, 'member'));
grant delete on public.skills to authenticated;

drop trigger if exists append_skill_version on public.skills;
drop trigger if exists bump_skill_version on public.skills;
drop policy if exists skill_versions_select_viewer on public.skill_versions;
drop trigger if exists skill_versions_block_truncate on public.skill_versions;
drop trigger if exists skill_versions_block_delete on public.skill_versions;
drop trigger if exists skill_versions_block_update on public.skill_versions;
drop table if exists public.skill_versions;
drop function if exists private.skill_versions_block_change();
drop function if exists private.append_skill_version();
drop function if exists private.bump_skill_version();
alter table public.skills drop constraint if exists skills_body_length_check;
