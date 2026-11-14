-- AGO-192: the audit trail of agent pack exports (epic EP-19).
--
-- Rollback: supabase/rollbacks/20261114020001_ago_192_pack_events.down.sql
--
-- Decisions (record: docs/tickets/AGO-192.md):
-- * One append-only table, public.pack_events. kind is 'export' today; the import ticket (AGO-194) adds 'import' by
--   widening the check. run_events needs a run_id and nothing else is workspace-level, so a pack export had no home.
-- * The event holds the exporter (a member id) and the agent ids and names. It never holds pack content, skill text,
--   prompts or any secret. The checksum is the SHA-256 of the exported content, which is not secret.
-- * Nobody writes the table directly: no INSERT grant for any API role. The only writer is
--   public.record_pack_export(), a SECURITY DEFINER function for signed-in members (never service_role, never an
--   agent token: an agent has no auth.uid()). It pins the exporter to the caller's own member id and derives the agent
--   names from the agents table, so a caller cannot forge either.
-- * Members and viewers of the workspace can read it (RLS). UPDATE, DELETE and TRUNCATE are refused for every role by a
--   trigger that is enabled always (same guard as claim_events).

create table public.pack_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('export')),
  exported_by uuid not null, -- the human member who exported
  agent_ids uuid[] not null check (cardinality(agent_ids) between 1 and 100),
  agent_names text[] not null,
  skill_count integer not null check (skill_count >= 0),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, exported_by) references public.members (workspace_id, id) on delete no action,
  check (cardinality(agent_names) = cardinality(agent_ids))
);
comment on table public.pack_events is 'Append-only audit trail of agent pack exports (AGO-192): who exported which agents. Never holds pack content or secrets. Written only by record_pack_export(). UPDATE and DELETE are blocked for every role.';
create index pack_events_workspace_created_idx on public.pack_events (workspace_id, created_at);
create index pack_events_workspace_exported_by_idx on public.pack_events (workspace_id, exported_by);
alter table public.pack_events enable row level security;

create function private.pack_events_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deleting the whole workspace cascades here: by then the workspace row is gone.
  if tg_op = 'DELETE' and tg_level = 'ROW'
     and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  raise exception 'pack_events is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Insert a new event instead.';
end;
$$;
revoke all on function private.pack_events_block_change() from public, anon, authenticated;
create trigger pack_events_block_update_delete before update or delete on public.pack_events
  for each row execute function private.pack_events_block_change();
create trigger pack_events_block_truncate before truncate on public.pack_events
  for each statement execute function private.pack_events_block_change();
alter table public.pack_events enable always trigger pack_events_block_update_delete;
alter table public.pack_events enable always trigger pack_events_block_truncate;

revoke all on table public.pack_events from public, anon, authenticated, service_role;
grant select on public.pack_events to authenticated, service_role;
create policy pack_events_select_member on public.pack_events for select to authenticated
  using (private.is_member(workspace_id));

-- The one writer. Members and owners may export; a viewer may not. Returns the event id.
create function public.record_pack_export(
  p_workspace_id uuid,
  p_agent_ids uuid[],
  p_skill_count integer,
  p_checksum text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_ids uuid[];
  v_names text[];
  v_event_id uuid;
begin
  if not private.is_member(p_workspace_id, 'member') then
    raise exception 'only workspace members can export agents' using errcode = '42501';
  end if;
  v_member_id := private.current_member_id(p_workspace_id);
  if v_member_id is null then
    raise exception 'only workspace members can export agents' using errcode = '42501';
  end if;

  select array_agg(a.id order by a.name), array_agg(a.name order by a.name)
    into v_ids, v_names
    from public.agents a
   where a.workspace_id = p_workspace_id and a.id = any (coalesce(p_agent_ids, '{}'));
  if v_ids is null or cardinality(v_ids) <> (select count(distinct x) from unnest(p_agent_ids) as x) then
    raise exception 'an agent does not exist in this workspace' using errcode = 'P0002';
  end if;

  insert into public.pack_events (workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum)
  values (p_workspace_id, 'export', v_member_id, v_ids, v_names, p_skill_count, p_checksum)
  returning id into v_event_id;
  return v_event_id;
end;
$$;
comment on function public.record_pack_export(uuid, uuid[], integer, text) is 'Appends a pack export event for the calling member (AGO-192). Names come from the agents table; the exporter is the caller. Members and owners only.';
revoke all on function public.record_pack_export(uuid, uuid[], integer, text) from public, anon, authenticated, service_role;
grant execute on function public.record_pack_export(uuid, uuid[], integer, text) to authenticated;
