-- AGO-96: department hooks and the layered policy table.
-- Builds on AGO-74 (tables), AGO-82 (private.is_member) and AGO-107 (per-command RLS and exact grants).
-- Rollback: supabase/rollbacks/20261106130001_ago_96_department_hooks_policies.down.sql
--
-- 1. department_id: a nullable hook on agents, tasks, approvals and notes_index (the vault index; there is
--    no table called `notes`). There is no departments table yet (AGO-108, EP-15), so there is no FK:
--    AGO-108 adds `departments` and the composite FK (workspace_id, department_id). Until then the column
--    is null everywhere, is in no INSERT or UPDATE grant for `authenticated`, and every existing flow is
--    unchanged. Only service_role (and later a human-only path) can set it.
-- 2. public.policies: layered policy storage (baseline < department < team < agent). Storage and shape
--    only; evaluation is the policy engine (AGO-34). Humans decide: only workspace owners can write
--    policies, agents are never members and have no user JWT, nobody can hard-delete (archive instead).

alter table public.agents add column department_id uuid;
alter table public.tasks add column department_id uuid;
alter table public.approvals add column department_id uuid;
alter table public.notes_index add column department_id uuid;

comment on column public.agents.department_id is 'Hook for departments (AGO-108). Null = no department. No FK until the departments table exists.';
comment on column public.tasks.department_id is 'Hook for departments (AGO-108). Null = no department. No FK until the departments table exists.';
comment on column public.approvals.department_id is 'Hook for departments (AGO-108). Null = no department. No FK until the departments table exists.';
comment on column public.notes_index.department_id is 'Hook for departments (AGO-108). Null = no department. No FK until the departments table exists.';

-- Partial indexes: nearly every row has a null department, so index only the rows that have one.
create index agents_workspace_department_idx on public.agents (workspace_id, department_id) where department_id is not null;
create index tasks_workspace_department_idx on public.tasks (workspace_id, department_id) where department_id is not null;
create index approvals_workspace_department_idx on public.approvals (workspace_id, department_id) where department_id is not null;
create index notes_index_workspace_department_idx on public.notes_index (workspace_id, department_id) where department_id is not null;

-- 2. policies
create table public.policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  level text not null check (level in ('baseline', 'department', 'team', 'agent')),
  scope_id uuid, -- the department, team or agent the policy applies to; null only for baseline
  rule jsonb not null check (jsonb_typeof(rule) = 'object'), -- shape validated by policyRuleSchema (@ago/shared)
  version integer not null default 1 check (version >= 1), -- bumped by trigger whenever `rule` changes
  archived_at timestamptz, -- retire a policy instead of deleting it
  created_by uuid not null, -- the human (owner) member who wrote it
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  constraint policies_scope_matches_level check (
    (level = 'baseline' and scope_id is null) or (level <> 'baseline' and scope_id is not null)
  ),
  foreign key (workspace_id, created_by) references public.members (workspace_id, id) on delete no action,
  foreign key (workspace_id, updated_by) references public.members (workspace_id, id) on delete no action
);
comment on table public.policies is 'Layered policy rules (baseline, department, team, agent). Storage only; evaluation is the policy engine (AGO-34). Written by workspace owners only.';
comment on column public.policies.scope_id is 'Department, team or agent id. Polymorphic with no FK (departments and teams do not exist yet); null for baseline.';

-- One active policy per scope. nulls not distinct makes the baseline (scope_id null) unique per workspace too.
-- Also serves lookups by (workspace_id, level, scope_id).
create unique index policies_workspace_level_scope_active_idx
  on public.policies (workspace_id, level, scope_id) nulls not distinct
  where archived_at is null;
create index policies_workspace_created_by_idx on public.policies (workspace_id, created_by);
create index policies_workspace_updated_by_idx on public.policies (workspace_id, updated_by);

create trigger set_updated_at before update on public.policies
  for each row execute function private.set_updated_at();

-- version moves forward by one on every rule change, whatever the caller sends (`version` is also not
-- in any grant). Runs as the invoker: it only edits NEW.
create function private.bump_policy_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rule is distinct from old.rule then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end
$$;
-- A trigger function needs no EXECUTE for the caller; nobody may call it directly (catalog test).
revoke all on function private.bump_policy_version() from public, anon, authenticated;
create trigger bump_policy_version before update on public.policies
  for each row execute function private.bump_policy_version();

alter table public.policies enable row level security;

-- Privileges: select for every member; insert and update for owners (the policy checks the role).
-- level, scope_id, workspace_id, version and created_* are never updatable, so a policy cannot be
-- re-pointed at another scope or workspace. No DELETE for anyone: archive (archived_at) instead.
revoke all on table public.policies from anon, authenticated;
grant select on public.policies to authenticated;
grant insert (workspace_id, level, scope_id, rule, created_by, updated_by) on public.policies to authenticated;
grant update (rule, archived_at, updated_by) on public.policies to authenticated;

create policy policies_select_viewer on public.policies for select to authenticated
  using (private.is_member(workspace_id));
create policy policies_insert_owner on public.policies for insert to authenticated
  with check (
    private.is_member(workspace_id, 'owner')
    and created_by = private.current_member_id(workspace_id)
    and updated_by = private.current_member_id(workspace_id)
  );
-- USING requires the old row to be active: an archived policy is history and cannot be edited or
-- un-archived through the API (archiving itself still works, because USING sees the active row).
create policy policies_update_owner on public.policies for update to authenticated
  using (private.is_member(workspace_id, 'owner') and archived_at is null)
  with check (
    private.is_member(workspace_id, 'owner')
    and updated_by = private.current_member_id(workspace_id)
  );
