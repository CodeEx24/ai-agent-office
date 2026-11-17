-- AGO-84: the kill switch. One owner action contains a whole workspace or one agent: it revokes every live
-- credential in scope and flags every live run in scope for a stop. Nothing is deleted, so the state stays for review.
--
-- Rollback: supabase/rollbacks/20261117010001_ago_84_kill_switch.down.sql
--
-- Decisions (docs/tickets/AGO-84.md):
-- * The latch lives in private.kill_switches. RLS is on and no API role has any grant, so only the worker's database
--   role (the table owner) and the two SECURITY DEFINER functions below can read or write it. The worker reads it at
--   every tool-call boundary and before it issues a credential, and fails closed when it cannot read it.
-- * The web app reaches the latch only through public.activate_kill_switch and public.release_kill_switch. Both are
--   executable by `authenticated` only and are human-only twice over: they refuse a caller with no user session or a
--   token that carries an agent claim, and they refuse anyone who is not an active OWNER of the workspace named in the
--   call. Agent credentials are signed tokens, never auth users, so they cannot reach them.
-- * Activation reuses the AGO-86 stop path: it writes private.run_checkpoints.stop_requested_at for every queued,
--   running or paused run in scope, and the worker (loop or control sweep) finishes the stop and writes run.stopped
--   (reason stopped_by_human, decision D6). It writes no run_events row and never changes public.runs.
-- * Credentials are revoked with the one change the append-only trigger allows (revoked_at null -> timestamp).
-- * Releasing lets new work start. It never revives a stopped run (stop is final) and never un-revokes a credential.
-- * The issuance latch is its own trigger on public.agent_credentials, so AGO-148's check function is left untouched.
--   It is the database-side wall: whatever the worker does, no credential row can be inserted while a switch is live.
-- * public.record_agent_approval_rejection (AGO-58, widened by AGO-86) also accepts /api/control/kill and
--   /api/control/kill/release and writes error.raised with code control_route_rejected. Same checks and flood bound.

create table private.kill_switches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  scope text not null check (scope in ('workspace', 'agent')),
  agent_id uuid,
  activated_at timestamptz not null default now(),
  activated_by uuid not null,
  released_at timestamptz,
  released_by uuid,
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  constraint kill_switches_scope_agent_check check ((scope = 'agent') = (agent_id is not null)),
  constraint kill_switches_released_check check ((released_at is null) = (released_by is null))
);
comment on table private.kill_switches is 'The kill switch latch (AGO-84): one live row per workspace or agent scope. Worker and definer functions only: no access for anon, authenticated or service_role.';

-- One live switch per scope.
create unique index kill_switches_live_idx on private.kill_switches
  (workspace_id, scope, coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where released_at is null;

alter table private.kill_switches enable row level security;
revoke all on private.kill_switches from public, anon, authenticated, service_role;

create function public.activate_kill_switch(p_workspace_id uuid, p_scope text, p_agent_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_runs integer;
  v_credentials integer;
begin
  if p_workspace_id is null or p_scope is null or p_scope not in ('workspace', 'agent')
     or (p_scope = 'agent') <> (p_agent_id is not null) then
    raise exception 'activate_kill_switch: invalid input' using errcode = '22023';
  end if;

  -- Human only: a real user session, never a token that carries an agent claim.
  if v_user is null
     or coalesce(v_claims ->> 'role', '') <> 'authenticated'
     or v_claims ?| array['agent_id', 'run_id', 'agent_credential'] then
    raise exception 'activate_kill_switch: a human session is required' using errcode = '42501';
  end if;
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'activate_kill_switch: not allowed' using errcode = '42501';
  end if;

  if p_scope = 'agent' and not exists (
    select 1 from public.agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id
  ) then
    raise exception 'activate_kill_switch: unknown agent' using errcode = '22023';
  end if;

  -- The latch first: from here on no credential can be issued in scope. A second activation changes nothing.
  insert into private.kill_switches (workspace_id, scope, agent_id, activated_by)
  values (p_workspace_id, p_scope, p_agent_id, v_user)
  on conflict do nothing;

  -- Flag every live run in scope for a stop (the AGO-86 flag). Only runs not flagged yet are counted.
  insert into private.run_checkpoints as c (workspace_id, run_id, stop_requested_at, control_requested_by)
  select r.workspace_id, r.id, now(), v_user
    from public.runs r
   where r.workspace_id = p_workspace_id
     and (p_scope = 'workspace' or r.agent_id = p_agent_id)
     and r.status in ('queued', 'running', 'paused')
  on conflict (workspace_id, run_id) do update
    set stop_requested_at = now(),
        control_requested_by = excluded.control_requested_by
    where c.stop_requested_at is null;
  get diagnostics v_runs = row_count;

  -- Revoke every live credential in scope. The rows stay: the log is append-only.
  update public.agent_credentials
     set revoked_at = now()
   where workspace_id = p_workspace_id
     and revoked_at is null
     and (p_scope = 'workspace' or agent_id = p_agent_id);
  get diagnostics v_credentials = row_count;

  return jsonb_build_object('runs_stopped', v_runs, 'credentials_revoked', v_credentials);
end;
$$;

revoke all on function public.activate_kill_switch(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.activate_kill_switch(uuid, text, uuid) to authenticated;
comment on function public.activate_kill_switch(uuid, text, uuid) is
  'AGO-84: an owner pulls the kill switch for a workspace or one agent. Latches the scope, flags its live runs for a stop and revokes its credentials. Human session required, owner role, workspace scoped; writes no run_events and deletes nothing.';

create function public.release_kill_switch(p_workspace_id uuid, p_scope text, p_agent_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
begin
  if p_workspace_id is null or p_scope is null or p_scope not in ('workspace', 'agent')
     or (p_scope = 'agent') <> (p_agent_id is not null) then
    raise exception 'release_kill_switch: invalid input' using errcode = '22023';
  end if;

  if v_user is null
     or coalesce(v_claims ->> 'role', '') <> 'authenticated'
     or v_claims ?| array['agent_id', 'run_id', 'agent_credential'] then
    raise exception 'release_kill_switch: a human session is required' using errcode = '42501';
  end if;
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'release_kill_switch: not allowed' using errcode = '42501';
  end if;

  -- Only the latch. Stopped runs stay stopped and revoked credentials stay revoked.
  update private.kill_switches
     set released_at = now(), released_by = v_user
   where workspace_id = p_workspace_id
     and scope = p_scope
     and agent_id is not distinct from p_agent_id
     and released_at is null;

  return jsonb_build_object('runs_stopped', 0, 'credentials_revoked', 0);
end;
$$;

revoke all on function public.release_kill_switch(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_kill_switch(uuid, text, uuid) to authenticated;
comment on function public.release_kill_switch(uuid, text, uuid) is
  'AGO-84: an owner releases the kill switch for a scope. Lets new work start; never revives a stopped run or a revoked credential. Same checks as activate_kill_switch.';

-- The database-side issuance latch: no credential row can be inserted while a switch covers the workspace or agent.
create function private.check_kill_switch_on_credential_issue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from private.kill_switches k
     where k.workspace_id = new.workspace_id
       and k.released_at is null
       and (k.scope = 'workspace' or (k.scope = 'agent' and k.agent_id = new.agent_id))
  ) then
    raise exception 'no credential can be issued while the kill switch is active' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.check_kill_switch_on_credential_issue() from public, anon, authenticated;
create trigger check_kill_switch_on_credential_issue before insert on public.agent_credentials
  for each row execute function private.check_kill_switch_on_credential_issue();
alter table public.agent_credentials enable always trigger check_kill_switch_on_credential_issue;

-- AGO-58's event function (widened by AGO-86), widened again to the kill routes (same checks, same event code).
create or replace function public.record_agent_approval_rejection(
  p_workspace_id uuid,
  p_run_id uuid,
  p_agent_id uuid,
  p_jti uuid,
  p_route text,
  p_method text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if p_workspace_id is null or p_run_id is null or p_agent_id is null or p_jti is null then
    raise exception 'record_agent_approval_rejection: ids are required' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE') then
    raise exception 'record_agent_approval_rejection: unsupported method' using errcode = '22023';
  end if;
  if p_route is not null and char_length(p_route) <= 400
     and (p_route = '/api/approvals' or p_route like '/api/approvals/%') then
    v_code := 'approval_route_rejected';
  elsif p_route is not null and char_length(p_route) <= 400
     and (p_route ~ '^/api/runs/[0-9a-fA-F-]{36}/control$' or p_route ~ '^/api/control/kill(/release)?$') then
    v_code := 'control_route_rejected';
  else
    raise exception 'record_agent_approval_rejection: not a human-only route' using errcode = '22023';
  end if;

  -- A genuinely issued credential for exactly this workspace, agent and run. Revoked or expired still counts.
  if not exists (
    select 1
    from public.agent_credentials c
    where c.id = p_jti
      and c.workspace_id = p_workspace_id
      and c.agent_id = p_agent_id
      and c.run_id = p_run_id
  ) then
    raise exception 'record_agent_approval_rejection: unknown credential' using errcode = '42501';
  end if;

  -- Flood bound per code: stay quiet past 20 per run per minute (the 403 is unaffected). Best-effort.
  if (
    select count(*)
    from public.run_events e
    where e.workspace_id = p_workspace_id
      and e.run_id = p_run_id
      and e.type = 'error.raised'
      and e.payload ->> 'code' = v_code
      and e.created_at > now() - interval '1 minute'
  ) >= 20 then
    return;
  end if;

  insert into public.run_events (workspace_id, run_id, type, payload)
  values (
    p_workspace_id,
    p_run_id,
    'error.raised',
    jsonb_build_object(
      'version', 1,
      'code', v_code,
      'message', p_method || ' ' || p_route,
      'retryable', false
    )
  );
end;
$$;
-- create or replace keeps the grants (service_role only); restated so the file is self-checking.
revoke all on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  to service_role;
