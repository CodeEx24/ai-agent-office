-- Rollback for 20261106120001_ago_107_rls_every_table.sql (local DB only).
-- Afterwards delete the migration row from supabase_migrations.schema_migrations to re-apply.
alter policy members_select_viewer on public.members rename to members_select_member;
alter policy workspaces_select_viewer on public.workspaces rename to workspaces_select_member;

drop policy if exists notes_index_delete_member on public.notes_index;
drop policy if exists notes_index_update_member on public.notes_index;
drop policy if exists notes_index_insert_member on public.notes_index;
drop policy if exists notes_index_select_viewer on public.notes_index;
drop policy if exists budgets_usage_update_owner on public.budgets_usage;
drop policy if exists budgets_usage_insert_owner on public.budgets_usage;
drop policy if exists budgets_usage_select_viewer on public.budgets_usage;
drop policy if exists claims_select_viewer on public.claims;
drop policy if exists approvals_update_member on public.approvals;
drop policy if exists approvals_select_viewer on public.approvals;
drop policy if exists run_events_select_viewer on public.run_events;
drop policy if exists runs_insert_member on public.runs;
drop policy if exists runs_select_viewer on public.runs;
drop policy if exists tasks_delete_member on public.tasks;
drop policy if exists tasks_update_member on public.tasks;
drop policy if exists tasks_insert_member on public.tasks;
drop policy if exists tasks_select_viewer on public.tasks;
drop policy if exists agent_capabilities_delete_owner on public.agent_capabilities;
drop policy if exists agent_capabilities_insert_owner on public.agent_capabilities;
drop policy if exists agent_capabilities_select_viewer on public.agent_capabilities;
drop policy if exists agent_skills_delete_member on public.agent_skills;
drop policy if exists agent_skills_insert_member on public.agent_skills;
drop policy if exists agent_skills_select_viewer on public.agent_skills;
drop policy if exists skills_delete_member on public.skills;
drop policy if exists skills_update_member on public.skills;
drop policy if exists skills_insert_member on public.skills;
drop policy if exists skills_select_viewer on public.skills;
drop policy if exists agents_delete_owner on public.agents;
drop policy if exists agents_update_member on public.agents;
drop policy if exists agents_insert_member on public.agents;
drop policy if exists agents_select_viewer on public.agents;

-- Privileges: back to the AGO-82 state (authenticated keeps select on workspaces/members only).
revoke all on table
  public.agents, public.skills, public.agent_skills, public.agent_capabilities, public.tasks,
  public.runs, public.run_events, public.approvals, public.claims, public.budgets_usage, public.notes_index
  from authenticated;

drop function if exists private.current_member_id(uuid);
