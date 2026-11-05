-- AGO-107: row-level security policies and exact grants for every table in `public`.
-- Builds on AGO-74 (tables, RLS on, no policies), AGO-82 (private.is_member), AGO-102 (run_events append-only).
-- Rollback: supabase/rollbacks/20261106120001_ago_107_rls_every_table.down.sql
--
-- Role matrix (viewer < member < owner; every policy is `to authenticated`, anon holds nothing):
--   table               select  insert  update  delete
--   workspaces          viewer  -       owner   -        (AGO-82; name column only)
--   members             viewer  -       -       -        (AGO-82; changed by RPC / human-only flows)
--   agents              viewer  member  member  owner    (mode/status are not writable: always strict)
--   skills              viewer  member  member  member
--   agent_skills        viewer  member  -       member
--   agent_capabilities  viewer  owner   -       owner    (granted_by pinned to the caller's membership)
--   tasks               viewer  member  member  member   (created_by pinned to the caller or null)
--   runs                viewer  member  -       -        (insert = queue a run; the runtime owns the rest)
--   run_events          viewer  -       -       -        (append-only; written by the runtime only)
--   approvals           viewer  -       member  -        (decide only: pending -> approved/denied, by the caller)
--   claims              viewer  -       -       -        (runtime only)
--   budgets_usage       viewer  owner   owner   -        (budget columns only; usage columns are runtime-only)
--   notes_index         viewer  member  member  member
-- "-" means no privilege and no policy for authenticated: only service_role (runtime) or a future
-- human-only RPC can do it. workspace_id (and every id/FK/audit column) is never in an UPDATE grant,
-- so a row cannot be moved to another workspace; the WITH CHECK clauses repeat the membership test.

-- 1. Helper: the caller's active membership id in a workspace, for pinning attribution columns
--    (granted_by, decided_by, created_by) to the real human. SECURITY DEFINER so it can read members
--    without recursing into its policy; only ever answers about auth.uid().
create function private.current_member_id(p_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.members m
  where m.workspace_id = p_workspace_id
    and m.user_id = (select auth.uid())
    and m.removed_at is null
  limit 1
$$;
comment on function private.current_member_id(uuid) is 'The calling user''s active member id in the workspace, or null. Used by RLS to pin granted_by / decided_by / created_by to the caller.';
revoke all on function private.current_member_id(uuid) from public, anon, authenticated;
grant execute on function private.current_member_id(uuid) to authenticated;

-- 2. Grants (privileges are the first gate, policies the second). RLS does not cover columns, so the
--    column lists below are what keeps workspace_id, ids, hashes and runtime state immutable.
grant select on
  public.agents, public.skills, public.agent_skills, public.agent_capabilities, public.tasks,
  public.runs, public.run_events, public.approvals, public.claims, public.budgets_usage, public.notes_index
  to authenticated;

grant insert (workspace_id, name, description) on public.agents to authenticated;
grant update (name, description, archived_at) on public.agents to authenticated;
grant delete on public.agents to authenticated;

grant insert (workspace_id, name, description, body) on public.skills to authenticated;
grant update (name, description, body) on public.skills to authenticated;
grant delete on public.skills to authenticated;

grant insert (workspace_id, agent_id, skill_id) on public.agent_skills to authenticated;
grant delete on public.agent_skills to authenticated;

grant insert (workspace_id, agent_id, capability, tier, granted_by) on public.agent_capabilities to authenticated;
grant delete on public.agent_capabilities to authenticated;

grant insert (workspace_id, title, description, status, agent_id, created_by) on public.tasks to authenticated;
grant update (title, description, status, agent_id) on public.tasks to authenticated;
grant delete on public.tasks to authenticated;

grant insert (workspace_id, task_id, agent_id) on public.runs to authenticated;

grant update (status, decided_by, decided_at) on public.approvals to authenticated;

grant insert (workspace_id, agent_id, period_start, period_end, token_budget, cost_budget_cents) on public.budgets_usage to authenticated;
grant update (period_end, token_budget, cost_budget_cents) on public.budgets_usage to authenticated;

grant insert (workspace_id, path, title, content_hash, metadata) on public.notes_index to authenticated;
grant update (title, content_hash, metadata, indexed_at) on public.notes_index to authenticated;
grant delete on public.notes_index to authenticated;

-- 3. Policies. Names: <table>_<command>_<minimum role>.
-- agents
create policy agents_select_viewer on public.agents for select to authenticated
  using (private.is_member(workspace_id));
create policy agents_insert_member on public.agents for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy agents_update_member on public.agents for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
create policy agents_delete_owner on public.agents for delete to authenticated
  using (private.is_member(workspace_id, 'owner'));

-- skills
create policy skills_select_viewer on public.skills for select to authenticated
  using (private.is_member(workspace_id));
create policy skills_insert_member on public.skills for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy skills_update_member on public.skills for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
create policy skills_delete_member on public.skills for delete to authenticated
  using (private.is_member(workspace_id, 'member'));

-- agent_skills (no update: re-link instead)
create policy agent_skills_select_viewer on public.agent_skills for select to authenticated
  using (private.is_member(workspace_id));
create policy agent_skills_insert_member on public.agent_skills for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy agent_skills_delete_member on public.agent_skills for delete to authenticated
  using (private.is_member(workspace_id, 'member'));

-- agent_capabilities: owner only, and the grant is attributed to the human who made it.
-- No update: change a capability by deleting it and granting a new one (new attribution).
create policy agent_capabilities_select_viewer on public.agent_capabilities for select to authenticated
  using (private.is_member(workspace_id));
create policy agent_capabilities_insert_owner on public.agent_capabilities for insert to authenticated
  with check (
    private.is_member(workspace_id, 'owner')
    and granted_by = private.current_member_id(workspace_id)
  );
create policy agent_capabilities_delete_owner on public.agent_capabilities for delete to authenticated
  using (private.is_member(workspace_id, 'owner'));

-- tasks
create policy tasks_select_viewer on public.tasks for select to authenticated
  using (private.is_member(workspace_id));
create policy tasks_insert_member on public.tasks for insert to authenticated
  with check (
    private.is_member(workspace_id, 'member')
    and (created_by is null or created_by = private.current_member_id(workspace_id))
  );
create policy tasks_update_member on public.tasks for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
create policy tasks_delete_member on public.tasks for delete to authenticated
  using (private.is_member(workspace_id, 'member'));

-- runs: a member can queue a run (status/started_at/finished_at are not insertable, so it starts
-- 'queued'); everything after that is the runtime's. History is never deleted through the API.
create policy runs_select_viewer on public.runs for select to authenticated
  using (private.is_member(workspace_id));
create policy runs_insert_member on public.runs for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));

-- run_events: read-only for humans (append-only, AGO-102; the runtime writes as service_role).
create policy run_events_select_viewer on public.run_events for select to authenticated
  using (private.is_member(workspace_id));

-- approvals: humans decide, never create. Only a pending, unexpired, unconsumed approval can be
-- decided, only to approved/denied, and decided_by must be the caller's own membership. payload_hash,
-- action, agent_id, run_id, expires_at and consumed_at are not in the UPDATE grant: the approval stays
-- bound to the payload hash it was created with. An expired approval can no longer be approved.
create policy approvals_select_viewer on public.approvals for select to authenticated
  using (private.is_member(workspace_id));
create policy approvals_update_member on public.approvals for update to authenticated
  using (
    private.is_member(workspace_id, 'member')
    and status = 'pending'
    and consumed_at is null
    and expires_at > now()
  )
  with check (
    private.is_member(workspace_id, 'member')
    and status in ('approved', 'denied')
    and decided_by = private.current_member_id(workspace_id)
    and decided_at is not null
  );

-- claims: runtime only.
create policy claims_select_viewer on public.claims for select to authenticated
  using (private.is_member(workspace_id));

-- budgets_usage: owners set budgets; usage counters are runtime-only (not in any grant). No delete.
create policy budgets_usage_select_viewer on public.budgets_usage for select to authenticated
  using (private.is_member(workspace_id));
create policy budgets_usage_insert_owner on public.budgets_usage for insert to authenticated
  with check (private.is_member(workspace_id, 'owner'));
create policy budgets_usage_update_owner on public.budgets_usage for update to authenticated
  using (private.is_member(workspace_id, 'owner'))
  with check (private.is_member(workspace_id, 'owner'));

-- notes_index
create policy notes_index_select_viewer on public.notes_index for select to authenticated
  using (private.is_member(workspace_id));
create policy notes_index_insert_member on public.notes_index for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));
create policy notes_index_update_member on public.notes_index for update to authenticated
  using (private.is_member(workspace_id, 'member'))
  with check (private.is_member(workspace_id, 'member'));
create policy notes_index_delete_member on public.notes_index for delete to authenticated
  using (private.is_member(workspace_id, 'member'));

-- 4. Rename the AGO-82 policies to the same <table>_<command>_<minimum role> scheme.
alter policy workspaces_select_member on public.workspaces rename to workspaces_select_viewer;
alter policy members_select_member on public.members rename to members_select_viewer;
