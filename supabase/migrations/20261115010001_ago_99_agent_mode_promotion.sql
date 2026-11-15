-- AGO-99: new agents start in Strict; only a signed-in workspace owner can promote (or demote) one, and every
-- change is logged. Decisions (record: docs/tickets/AGO-99.md): one append-only table agent_mode_changes; any mode to
-- any other, owner only; agent credentials and service callers are refused.
--
-- * agents.mode gets a CHECK (strict, standard, relaxed). The column default stays 'strict'. mode stays out of every
--   column grant, so the API still cannot write it.
-- * An insert guard (BEFORE INSERT) refuses a new agent in any mode but 'strict', for every role.
-- * A log trigger (AFTER UPDATE OF mode, SECURITY DEFINER) is the one writer of the log. Whoever changes agents.mode
--   by whatever route (set_agent_mode(), PostgREST, service_role, a worker connection, the table owner) must be a
--   signed-in owner of the agent's workspace (auth.uid() is set, owner role), or the update is refused; the row it
--   writes carries that owner's member id. There is no session flag to forge. Both triggers are ENABLE ALWAYS, so
--   session_replication_role does not skip them.
--   Limit: a role that can ALTER TABLE ... DISABLE TRIGGER (the table owner, a superuser) can still turn the triggers
--   off. That is infrastructure access, outside what this migration can guard.
-- * set_agent_mode() is the human entry point: SECURITY DEFINER with an explicit owner check on auth.uid(). An agent
--   credential has no auth.uid() (no member), so it is refused; execute is revoked from service_role, anon and PUBLIC.
-- * The log holds who (a member id), from, to and when. Never any prompt or run content.

-- 1. The mode allow-list. Fail loudly if a row holds anything else (the app already maps unknown to strict).
do $$
begin
  if exists (select 1 from public.agents where mode not in ('strict', 'standard', 'relaxed')) then
    raise exception 'agents.mode holds a value outside strict, standard, relaxed; fix those rows first';
  end if;
end $$;
alter table public.agents
  add constraint agents_mode_check check (mode in ('strict', 'standard', 'relaxed'));

-- 2. The log.
create table public.agent_mode_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  from_mode text not null check (from_mode in ('strict', 'standard', 'relaxed')),
  to_mode text not null check (to_mode in ('strict', 'standard', 'relaxed')),
  changed_by uuid not null, -- the human member who changed it
  created_at timestamptz not null default now(),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, changed_by) references public.members (workspace_id, id) on delete no action,
  check (from_mode <> to_mode)
);
comment on table public.agent_mode_changes is 'Append-only log of agent mode changes (AGO-99): who moved which agent from which mode to which, and when. Written only by the agents mode log trigger. UPDATE and DELETE are blocked for every role.';
create index agent_mode_changes_workspace_agent_idx on public.agent_mode_changes (workspace_id, agent_id, created_at);
alter table public.agent_mode_changes enable row level security;

create function private.agent_mode_changes_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deleting the agent or the whole workspace cascades here: by then the parent row is gone.
  if tg_op = 'DELETE' and tg_level = 'ROW'
     and not exists (select 1 from public.agents a where a.workspace_id = old.workspace_id and a.id = old.agent_id) then
    return old;
  end if;
  raise exception 'agent_mode_changes is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Insert a new row instead.';
end;
$$;
revoke all on function private.agent_mode_changes_block_change() from public, anon, authenticated;
create trigger agent_mode_changes_block_update_delete before update or delete on public.agent_mode_changes
  for each row execute function private.agent_mode_changes_block_change();
create trigger agent_mode_changes_block_truncate before truncate on public.agent_mode_changes
  for each statement execute function private.agent_mode_changes_block_change();
alter table public.agent_mode_changes enable always trigger agent_mode_changes_block_update_delete;
alter table public.agent_mode_changes enable always trigger agent_mode_changes_block_truncate;

revoke all on table public.agent_mode_changes from public, anon, authenticated, service_role;
grant select on public.agent_mode_changes to authenticated, service_role; -- the runtime may read the log; nobody writes it directly
create policy agent_mode_changes_select_member on public.agent_mode_changes for select to authenticated
  using (private.is_member(workspace_id));

-- 3. The insert guard: a new agent starts in strict, whoever inserts it.
create function private.agents_guard_mode()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.mode <> 'strict' then
    raise exception 'a new agent starts in strict mode' using errcode = '42501', hint = 'Promote it afterwards.';
  end if;
  return new;
end;
$$;
revoke all on function private.agents_guard_mode() from public, anon, authenticated;
create trigger agents_guard_mode_insert before insert on public.agents
  for each row execute function private.agents_guard_mode();
alter table public.agents enable always trigger agents_guard_mode_insert;

-- 4. The log trigger: the owner check and the log row for ANY change of agents.mode, whatever route it takes.
--    SQLSTATE 42501 when there is no signed-in owner of the workspace. WHEN keeps an update that leaves the mode as it
--    is (set mode = mode) out of it.
create function private.agents_log_mode_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  if auth.uid() is null or not private.is_member(new.workspace_id, 'owner') then
    raise exception 'an agent mode can only be changed by a signed-in owner of the workspace' using errcode = '42501';
  end if;
  v_member_id := private.current_member_id(new.workspace_id);
  if v_member_id is null then
    raise exception 'an agent mode can only be changed by a signed-in owner of the workspace' using errcode = '42501';
  end if;
  insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by)
  values (new.workspace_id, new.id, old.mode, new.mode, v_member_id);
  return null;
end;
$$;
revoke all on function private.agents_log_mode_change() from public, anon, authenticated;
create trigger agents_log_mode_change after update of mode on public.agents
  for each row when (old.mode is distinct from new.mode) execute function private.agents_log_mode_change();
alter table public.agents enable always trigger agents_log_mode_change;

-- 5. The human entry point. Owners only; returns nothing. The trigger above writes the log row. Errors (SQLSTATE):
--    42501 not an owner, 22023 unknown mode, P0002 no such agent in this workspace, 55000 archived agent, AGM01 already
--    in that mode.
create function public.set_agent_mode(p_workspace_id uuid, p_agent_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_archived timestamptz;
begin
  if auth.uid() is null or not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can change an agent mode' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('strict', 'standard', 'relaxed') then
    raise exception 'mode must be strict, standard or relaxed' using errcode = '22023';
  end if;

  select mode, archived_at into v_from, v_archived
    from public.agents where workspace_id = p_workspace_id and id = p_agent_id
    for update;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
  if v_archived is not null then
    raise exception 'an archived agent cannot change mode' using errcode = '55000', hint = 'Unarchive the agent first.';
  end if;
  if v_from = p_mode then
    raise exception 'the agent is already in that mode' using errcode = 'AGM01';
  end if;

  update public.agents set mode = p_mode where workspace_id = p_workspace_id and id = p_agent_id;
end;
$$;
comment on function public.set_agent_mode(uuid, uuid, text) is 'Owners change an agent mode (AGO-99); the log trigger on agents writes the log row in the same transaction. Agent credentials and service_role cannot call it.';
revoke all on function public.set_agent_mode(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_agent_mode(uuid, uuid, text) to authenticated;
