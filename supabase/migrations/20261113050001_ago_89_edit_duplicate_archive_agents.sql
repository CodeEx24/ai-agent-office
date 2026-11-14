-- AGO-89: edit, duplicate and archive agents; model and thinking effort (EP-03).
-- Builds on AGO-74 (agents), AGO-82 (private.is_member), AGO-107 (RLS), AGO-128 (the append-only version
-- table pattern), AGO-141 (agent columns, create_agent) and AGO-148 (credentials revoked on archive).
-- Rollback: supabase/rollbacks/20261113050001_ago_89_edit_duplicate_archive_agents.down.sql
--
-- Decisions (full list in docs/tickets/AGO-89.md):
-- * Humans decide: only owners edit, duplicate, archive or unarchive. AGO-107 let members update agents
--   (name, description, archived_at); that policy is replaced by an owner-only one, so a member can no longer
--   rename or archive an agent, and the new editable columns (prompt, model, ...) are never writable by a member.
-- * One immutable table, public.agent_versions, is both the version history and the audit trail (it mirrors
--   skill_versions). A trigger on agents appends a row on insert and whenever a tracked column or archived_at
--   changes, so no code path (RPC, direct update, service role) can change an agent without leaving a version.
--   Worker writes to status or run_limits touch none of the tracked columns: no new version.
-- * agents.mode, status and department_id stay out of every grant. A duplicate takes the column default
--   (mode = 'strict'); the function has no way to pick another.
-- * Edits use an optimistic lock (p_expected_version): a stale edit is refused (40001), not merged.
-- * An archived agent cannot be edited or duplicated (55000): unarchive first. A trigger on tasks refuses a new
--   assignment to an archived agent. A task assigned before the agent was archived keeps its assignment
--   (history); the worker claim-path check is a follow-up.
-- * duplicate_agent runs as the caller (SECURITY INVOKER). run_limits has no column grant (AGO-166), so a copy
--   starts with the worker defaults; the owner can set limits again.

-- 1. Columns. thinking_effort is stored only: the worker does not use it yet (follow-up).
alter table public.agents
  add column thinking_effort text not null default 'medium' check (thinking_effort in ('low', 'medium', 'high')),
  add column version integer not null default 1 check (version >= 1);
comment on column public.agents.thinking_effort is 'low, medium or high (AGO-89). Mirrors AGENT_THINKING_EFFORTS in packages/shared. Stored only: the worker does not use it yet.';
comment on column public.agents.version is 'Moves forward by one on every change to a tracked column or archived_at (AGO-89). In no grant: set only by the trigger bump_agent_version.';

-- 2. The immutable history and audit trail.
create table public.agent_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  version integer not null check (version >= 1),
  change_kind text not null check (change_kind in ('create', 'edit', 'archive', 'unarchive')),
  changed_fields text[] not null default '{}',
  name text not null,
  role text not null default '',
  model text not null default '',
  thinking_effort text not null default 'medium',
  prompt text not null default '' check (char_length(prompt) <= 20000), -- untrusted text, stored, never executed
  daily_budget_cents integer,
  changed_by uuid, -- the human member who made the change; null for backfill and service-role writes
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, agent_id, version),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, changed_by) references public.members (workspace_id, id) on delete no action
);
create index agent_versions_workspace_changed_by_idx on public.agent_versions (workspace_id, changed_by);
comment on table public.agent_versions is 'Immutable version history and audit trail of an agent''s tracked settings (AGO-89). Appended by a trigger on agents; UPDATE and DELETE are blocked for every role.';

-- Backfill: every existing agent gets its current settings as version 1.
insert into public.agent_versions (workspace_id, agent_id, version, change_kind, name, role, model, thinking_effort, prompt, daily_budget_cents)
select workspace_id, id, version, 'create', name, role, model, thinking_effort, prompt, daily_budget_cents from public.agents;

-- 3. The version moves forward by one when a tracked column or archived_at changes, whatever the caller sends.
--    An archived agent's settings cannot change (unarchive first). Runs as the invoker: it only edits NEW.
create function private.bump_agent_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_settings_changed boolean;
begin
  v_settings_changed :=
    (new.name, new.role, new.model, new.thinking_effort, new.prompt, new.daily_budget_cents)
    is distinct from
    (old.name, old.role, old.model, old.thinking_effort, old.prompt, old.daily_budget_cents);
  if v_settings_changed and old.archived_at is not null and new.archived_at is not null then
    raise exception 'an archived agent cannot be edited' using errcode = '55000', hint = 'Unarchive the agent first.';
  end if;
  if v_settings_changed or new.archived_at is distinct from old.archived_at then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end
$$;
revoke all on function private.bump_agent_version() from public, anon, authenticated;
create trigger bump_agent_version before update on public.agents
  for each row execute function private.bump_agent_version();

-- 4. Append the version row. SECURITY DEFINER because authenticated has no INSERT on agent_versions.
create function private.append_agent_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_fields text[] := '{}';
begin
  if tg_op = 'INSERT' then
    v_kind := 'create';
  elsif new.version is distinct from old.version then
    if old.archived_at is null and new.archived_at is not null then
      v_kind := 'archive';
    elsif old.archived_at is not null and new.archived_at is null then
      v_kind := 'unarchive';
    else
      v_kind := 'edit';
    end if;
    if new.name is distinct from old.name then v_fields := array_append(v_fields, 'name'); end if;
    if new.role is distinct from old.role then v_fields := array_append(v_fields, 'role'); end if;
    if new.model is distinct from old.model then v_fields := array_append(v_fields, 'model'); end if;
    if new.thinking_effort is distinct from old.thinking_effort then v_fields := array_append(v_fields, 'thinking_effort'); end if;
    if new.prompt is distinct from old.prompt then v_fields := array_append(v_fields, 'prompt'); end if;
    if new.daily_budget_cents is distinct from old.daily_budget_cents then v_fields := array_append(v_fields, 'daily_budget_cents'); end if;
    if new.archived_at is distinct from old.archived_at then v_fields := array_append(v_fields, 'archived_at'); end if;
  else
    return null; -- status, run_limits and other untracked changes leave no version
  end if;
  insert into public.agent_versions (workspace_id, agent_id, version, change_kind, changed_fields, name, role, model,
                                     thinking_effort, prompt, daily_budget_cents, changed_by)
  values (new.workspace_id, new.id, new.version, v_kind, v_fields, new.name, new.role, new.model,
          new.thinking_effort, new.prompt, new.daily_budget_cents, private.current_member_id(new.workspace_id));
  return null;
end
$$;
revoke all on function private.append_agent_version() from public, anon, authenticated;
create trigger append_agent_version after insert or update on public.agents
  for each row execute function private.append_agent_version();

-- 5. Immutability, for every role (same shape as skill_versions).
create function private.agent_versions_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.agents a where a.id = old.agent_id)
          or not exists (select 1 from public.workspaces w where w.id = old.workspace_id)) then
    return old; -- the parent is already gone: this is the FK cascade
  end if;
  raise exception 'agent_versions is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Edit the agent again to create a new version.';
end
$$;
revoke all on function private.agent_versions_block_change() from public, anon, authenticated;
create trigger agent_versions_block_update before update on public.agent_versions
  for each row execute function private.agent_versions_block_change();
create trigger agent_versions_block_delete before delete on public.agent_versions
  for each row execute function private.agent_versions_block_change();
create trigger agent_versions_block_truncate before truncate on public.agent_versions
  for each statement execute function private.agent_versions_block_change();
alter table public.agent_versions enable always trigger agent_versions_block_update;
alter table public.agent_versions enable always trigger agent_versions_block_delete;
alter table public.agent_versions enable always trigger agent_versions_block_truncate;

-- 6. RLS and grants. agent_versions: read only.
alter table public.agent_versions enable row level security;
revoke all on table public.agent_versions from anon, authenticated;
grant select on public.agent_versions to authenticated;
revoke update, delete, truncate, trigger, references on table public.agent_versions from public, anon, authenticated, service_role;
revoke update (id, workspace_id, agent_id, version, change_kind, changed_fields, name, role, model, thinking_effort, prompt, daily_budget_cents, changed_by, created_at)
  on public.agent_versions from public, anon, authenticated, service_role;
create policy agent_versions_select_viewer on public.agent_versions for select to authenticated
  using (private.is_member(workspace_id));

-- 7. agents: owners edit. mode, status, department_id, run_limits, version and the identity columns stay ungranted.
drop policy agents_update_member on public.agents;
create policy agents_update_owner on public.agents for update to authenticated
  using (private.is_member(workspace_id, 'owner'))
  with check (private.is_member(workspace_id, 'owner'));
revoke update on public.agents from authenticated;
grant update (name, role, model, thinking_effort, prompt, daily_budget_cents, archived_at)
  on public.agents to authenticated;
-- A duplicate sets thinking_effort on insert (owner-only policy, AGO-141); everything else is unchanged.
revoke insert on public.agents from authenticated;
grant insert (workspace_id, name, description, role, model, thinking_effort, prompt, daily_budget_cents)
  on public.agents to authenticated;

-- 8. Archived agents cannot receive tasks. Insert, or a change of assignee to an archived agent, is refused.
--    A task that already points at an agent keeps it when the agent is archived later (the trigger only fires
--    when agent_id changes). SECURITY DEFINER so the check reads the agent whatever the caller can see;
--    FOR SHARE makes a concurrent archive wait for this assignment (or vice versa).
create function private.refuse_archived_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.agent_id is not null and exists (
       select 1 from public.agents a
        where a.workspace_id = new.workspace_id and a.id = new.agent_id and a.archived_at is not null
        for share) then
    raise exception 'an archived agent cannot receive tasks' using errcode = '55000', hint = 'Unarchive the agent or pick another.';
  end if;
  return new;
end
$$;
revoke all on function private.refuse_archived_assignee() from public, anon, authenticated;
create trigger refuse_archived_assignee_insert before insert on public.tasks
  for each row execute function private.refuse_archived_assignee();
create trigger refuse_archived_assignee_update before update of agent_id on public.tasks
  for each row when (new.agent_id is distinct from old.agent_id)
  execute function private.refuse_archived_assignee();

-- 9. The four owner actions. SECURITY INVOKER: RLS and the owner policies stay the enforcement point; the
--    functions also check the owner role so the failure is a clear error.
create function public.update_agent(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_version integer,
  p_name text,
  p_role text,
  p_model text,
  p_thinking_effort text,
  p_prompt text,
  p_daily_budget_cents integer
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version integer;
  v_archived timestamptz;
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can edit agents' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if p_role is null or char_length(p_role) > 120 or p_model is null or char_length(p_model) > 100
     or p_prompt is null or char_length(p_prompt) > 20000 then
    raise exception 'role, model or prompt is too long' using errcode = '22023';
  end if;
  if p_thinking_effort is null or p_thinking_effort not in ('low', 'medium', 'high') then
    raise exception 'thinking effort must be low, medium or high' using errcode = '22023';
  end if;
  if p_daily_budget_cents is null or p_daily_budget_cents < 1 or p_daily_budget_cents > 5000 then
    raise exception 'daily budget must be between 1 and 5000 cents' using errcode = '22023';
  end if;

  select version, archived_at into v_version, v_archived
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id for update;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
  if v_archived is not null then
    raise exception 'an archived agent cannot be edited' using errcode = '55000', hint = 'Unarchive the agent first.';
  end if;
  if v_version is distinct from p_expected_version then
    raise exception 'the agent was changed since you opened it' using errcode = '40001';
  end if;

  update public.agents
     set name = btrim(p_name), role = p_role, model = p_model, thinking_effort = p_thinking_effort,
         prompt = p_prompt, daily_budget_cents = p_daily_budget_cents
   where workspace_id = p_workspace_id and id = p_agent_id
   returning version into v_version;
  return v_version;
end;
$$;
comment on function public.update_agent(uuid, uuid, integer, text, text, text, text, text, integer) is 'Owners edit name, role, model, thinking effort, prompt and daily budget with an optimistic lock; the trigger appends the version (AGO-89).';
revoke all on function public.update_agent(uuid, uuid, integer, text, text, text, text, text, integer) from public, anon;
grant execute on function public.update_agent(uuid, uuid, integer, text, text, text, text, text, integer) to authenticated;

create function public.duplicate_agent(p_workspace_id uuid, p_agent_id uuid, p_name text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_id uuid;
  v_member_id uuid;
  v_archived timestamptz;
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can duplicate agents' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters' using errcode = '22023';
  end if;
  v_member_id := private.current_member_id(p_workspace_id);

  select archived_at into v_archived
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
  if v_archived is not null then
    raise exception 'an archived agent cannot be duplicated' using errcode = '55000', hint = 'Unarchive the agent first.';
  end if;

  -- mode is in no grant: the column default ('strict') is the only value the copy can get.
  insert into public.agents (workspace_id, name, description, role, model, thinking_effort, prompt, daily_budget_cents)
  select workspace_id, btrim(p_name), description, role, model, thinking_effort, prompt, daily_budget_cents
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id
  returning id into v_new_id;

  insert into public.agent_skills (workspace_id, agent_id, skill_id)
  select workspace_id, v_new_id, skill_id
    from public.agent_skills where workspace_id = p_workspace_id and agent_id = p_agent_id;

  -- The tier is read again from the catalog, never copied: a capability that is disabled now is skipped, and
  -- tier 3 and 4 are always 'approval'.
  insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode, granted_by)
  select ac.workspace_id, v_new_id, ac.capability, c.tier,
         case when c.tier >= 3 then 'approval' else ac.mode end, v_member_id
    from public.agent_capabilities ac
    join public.capabilities c on c.workspace_id = ac.workspace_id and c.key = ac.capability
   where ac.workspace_id = p_workspace_id and ac.agent_id = p_agent_id and c.enabled;

  return v_new_id;
end;
$$;
comment on function public.duplicate_agent(uuid, uuid, text) is 'Owners copy an agent with its skills and capability grants. The copy always starts in Strict mode (AGO-89).';
revoke all on function public.duplicate_agent(uuid, uuid, text) from public, anon;
grant execute on function public.duplicate_agent(uuid, uuid, text) to authenticated;

create function public.archive_agent(p_workspace_id uuid, p_agent_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_archived timestamptz;
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can archive agents' using errcode = '42501';
  end if;
  select archived_at into v_archived
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id for update;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
  if v_archived is not null then
    raise exception 'the agent is already archived' using errcode = '55000';
  end if;
  update public.agents set archived_at = now() where workspace_id = p_workspace_id and id = p_agent_id;
end;
$$;
comment on function public.archive_agent(uuid, uuid) is 'Owners archive an agent: it can no longer receive tasks or be edited until unarchived (AGO-89).';
revoke all on function public.archive_agent(uuid, uuid) from public, anon;
grant execute on function public.archive_agent(uuid, uuid) to authenticated;

create function public.unarchive_agent(p_workspace_id uuid, p_agent_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_archived timestamptz;
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can unarchive agents' using errcode = '42501';
  end if;
  select archived_at into v_archived
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id for update;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
  if v_archived is null then
    raise exception 'the agent is not archived' using errcode = '55000';
  end if;
  update public.agents set archived_at = null where workspace_id = p_workspace_id and id = p_agent_id;
end;
$$;
comment on function public.unarchive_agent(uuid, uuid) is 'Owners bring an archived agent back (AGO-89).';
revoke all on function public.unarchive_agent(uuid, uuid) from public, anon;
grant execute on function public.unarchive_agent(uuid, uuid) to authenticated;
