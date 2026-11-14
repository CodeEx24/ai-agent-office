-- Rollback for 20261113050001_ago_89_edit_duplicate_archive_agents.sql.
-- Removes the AGO-89 objects and restores the AGO-107 / AGO-141 agents policy and grants.
-- Data loss: agent version history, thinking_effort and version are dropped.

drop function if exists public.unarchive_agent(uuid, uuid);
drop function if exists public.archive_agent(uuid, uuid);
drop function if exists public.duplicate_agent(uuid, uuid, text);
drop function if exists public.update_agent(uuid, uuid, integer, text, text, text, text, text, integer);

drop trigger if exists refuse_archived_assignee_update on public.tasks;
drop trigger if exists refuse_archived_assignee_insert on public.tasks;
drop function if exists private.refuse_archived_assignee();

-- AGO-107: members update agents (name, description, archived_at). AGO-141: insert columns without thinking_effort.
drop policy if exists agents_update_owner on public.agents;
create policy agents_update_member on public.agents for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
revoke update on public.agents from authenticated;
grant update (name, description, archived_at) on public.agents to authenticated;
revoke insert on public.agents from authenticated;
grant insert (workspace_id, name, description, role, model, prompt, daily_budget_cents)
  on public.agents to authenticated;

drop trigger if exists append_agent_version on public.agents;
drop trigger if exists bump_agent_version on public.agents;
drop function if exists private.append_agent_version();
drop function if exists private.bump_agent_version();

-- Dropping the table drops its triggers; the block function goes after it. Immutability blocks DELETE, so the
-- table is dropped, not emptied.
drop table if exists public.agent_versions;
drop function if exists private.agent_versions_block_change();

alter table public.agents
  drop column if exists version,
  drop column if exists thinking_effort;
