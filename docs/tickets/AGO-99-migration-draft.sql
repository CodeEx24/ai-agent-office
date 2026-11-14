-- DRAFT for AGO-99. NOT under supabase/migrations on purpose: AGO-86 holds the schema slot.
-- When the orchestrator says the slot is free (after AGO-86's migration merged): copy this file to
-- supabase/migrations/<fresh timestamp after AGO-86's>_ago_99_agent_mode_promotion.sql, the .down.sql next to it
-- to supabase/rollbacks/<same timestamp>_ago_99_agent_mode_promotion.down.sql, then add the pgTAP file
-- (supabase/tests/agent_mode.test.sql) and update the catalog tests and docs/database.md. Nothing here has been run.
--
-- AGO-99: new agents start in Strict; only a signed-in workspace owner can promote (or demote) one, and every
-- change is logged. Decisions (record: docs/tickets/AGO-99.md): one append-only table agent_mode_changes written only
-- by set_agent_mode(); any mode to any other, owner only; agent tokens and service callers are refused.
--
-- * agents.mode gets a CHECK (strict, standard, relaxed). The column default stays 'strict'. mode stays out of every
--   column grant, so the API still cannot write it.
-- * A guard trigger on agents refuses ANY change of mode that does not come through set_agent_mode(), whoever the
--   caller is (service_role included). The function sets a transaction-local flag; nothing else does. So no code
--   path can change a mode without a log row, and a new row must start in 'strict'.
-- * set_agent_mode() is SECURITY DEFINER with an explicit owner check on auth.uid(). An agent credential has no
--   auth.uid() (no member), so it is refused; execute is revoked from service_role, anon and PUBLIC.
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
comment on table public.agent_mode_changes is 'Append-only log of agent mode changes (AGO-99): who moved which agent from which mode to which, and when. Written only by set_agent_mode(). UPDATE and DELETE are blocked for every role.';
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
grant select on public.agent_mode_changes to authenticated;
create policy agent_mode_changes_select_member on public.agent_mode_changes for select to authenticated
  using (private.is_member(workspace_id));

-- 3. The guard: a mode changes only inside set_agent_mode(), and a new agent starts in strict.
create function private.agents_guard_mode()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.mode <> 'strict' then
      raise exception 'a new agent starts in strict mode' using errcode = '42501', hint = 'Promote it afterwards.';
    end if;
  elsif new.mode is distinct from old.mode
        and coalesce(current_setting('ago.mode_change', true), '') <> 'on' then
    raise exception 'an agent mode changes only through set_agent_mode()' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.agents_guard_mode() from public, anon, authenticated;
create trigger agents_guard_mode_insert before insert on public.agents
  for each row execute function private.agents_guard_mode();
create trigger agents_guard_mode_update before update of mode on public.agents
  for each row execute function private.agents_guard_mode();

-- 4. The one writer. Owners only; returns nothing. Errors (SQLSTATE): 42501 not an owner, 22023 unknown mode,
--    P0002 no such agent in this workspace, 55000 archived agent, AGM01 already in that mode.
create function public.set_agent_mode(p_workspace_id uuid, p_agent_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_from text;
  v_archived timestamptz;
begin
  if auth.uid() is null or not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can change an agent mode' using errcode = '42501';
  end if;
  v_member_id := private.current_member_id(p_workspace_id);
  if v_member_id is null then
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

  perform set_config('ago.mode_change', 'on', true);
  update public.agents set mode = p_mode where workspace_id = p_workspace_id and id = p_agent_id;
  perform set_config('ago.mode_change', 'off', true);
  insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by)
  values (p_workspace_id, p_agent_id, v_from, p_mode, v_member_id);
end;
$$;
comment on function public.set_agent_mode(uuid, uuid, text) is 'Owners change an agent mode (AGO-99); the change and its log row are one transaction. Agent credentials and service_role cannot call it.';
revoke all on function public.set_agent_mode(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_agent_mode(uuid, uuid, text) to authenticated;
