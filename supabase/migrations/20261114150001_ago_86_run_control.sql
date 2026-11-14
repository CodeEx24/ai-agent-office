-- AGO-86: human-only pause, resume and stop for a run.
--
-- Rollback: supabase/rollbacks/20261114150001_ago_86_run_control.down.sql
--
-- Decisions (docs/tickets/AGO-86.md):
-- * The pause flag lives in private.run_checkpoints (AGO-30), which no API role can touch. The web app therefore
--   sets control flags through ONE narrow SECURITY DEFINER function, public.request_run_control. It is executable by
--   `authenticated` only and is human-only twice over: it refuses a caller that has no user session or whose token
--   carries an agent claim, and it refuses anyone who is not an active member (role member or owner) of the
--   workspace named in the call. Agent credentials are signed tokens, never auth users, so they cannot reach it.
-- * It only records a REQUEST (a timestamp and who asked). The worker acts on it: the loop reads pause and stop at
--   every tool-call boundary, and a worker sweep resumes or stops runs that no loop is holding. The function writes
--   no run_events row (run_events is runtime-only) and never changes public.runs, so it cannot skip an approval or
--   a budget check.
-- * Stop is final: `stopped` is a new free-text runs.status value (the column has no check, AGO-74). Once a stop is
--   requested, a resume request is refused, and the worker never moves a stopped run anywhere.
-- * public.record_agent_approval_rejection (AGO-58) is generalised, not duplicated: it now also accepts the control
--   route /api/runs/<uuid>/control and writes error.raised with code `control_route_rejected` for it. Same checks,
--   same flood bound per code, same service_role-only grant.

alter table private.run_checkpoints
  add column stop_requested_at timestamptz,
  add column resume_requested_at timestamptz,
  add column control_requested_by uuid;
comment on column private.run_checkpoints.stop_requested_at is 'A human asked for this run to stop for good (AGO-86). Never cleared: stop is final.';
comment on column private.run_checkpoints.resume_requested_at is 'A human asked for this paused run to resume (AGO-86). The worker sweep acts on it and clears it.';
comment on column private.run_checkpoints.control_requested_by is 'auth.uid() of the human behind the latest control request (AGO-86). Audit only.';

create function public.request_run_control(p_workspace_id uuid, p_run_id uuid, p_action text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_rows integer;
begin
  if p_workspace_id is null or p_run_id is null or p_action is null
     or p_action not in ('pause', 'resume', 'stop') then
    raise exception 'request_run_control: invalid input' using errcode = '22023';
  end if;

  -- Human only: a real user session, never a token that carries an agent claim.
  if v_user is null
     or coalesce(v_claims ->> 'role', '') <> 'authenticated'
     or v_claims ?| array['agent_id', 'run_id', 'agent_credential'] then
    raise exception 'request_run_control: a human session is required' using errcode = '42501';
  end if;
  if not private.is_member(p_workspace_id, 'member') then
    raise exception 'request_run_control: not allowed' using errcode = '42501';
  end if;

  if p_action = 'pause' then
    insert into private.run_checkpoints as c (workspace_id, run_id, pause_requested_at, control_requested_by)
    select r.workspace_id, r.id, now(), v_user
      from public.runs r
     where r.workspace_id = p_workspace_id and r.id = p_run_id and r.status in ('queued', 'running')
    on conflict (workspace_id, run_id) do update
      set pause_requested_at = coalesce(c.pause_requested_at, now()),
          control_requested_by = excluded.control_requested_by;
  elsif p_action = 'stop' then
    insert into private.run_checkpoints as c (workspace_id, run_id, stop_requested_at, control_requested_by)
    select r.workspace_id, r.id, now(), v_user
      from public.runs r
     where r.workspace_id = p_workspace_id and r.id = p_run_id and r.status in ('queued', 'running', 'paused')
    on conflict (workspace_id, run_id) do update
      set stop_requested_at = coalesce(c.stop_requested_at, now()),
          control_requested_by = excluded.control_requested_by;
  else
    -- resume: only a paused run that nobody asked to stop.
    insert into private.run_checkpoints as c (workspace_id, run_id, resume_requested_at, control_requested_by)
    select r.workspace_id, r.id, now(), v_user
      from public.runs r
     where r.workspace_id = p_workspace_id and r.id = p_run_id and r.status = 'paused'
       and not exists (
         select 1 from private.run_checkpoints k
          where k.workspace_id = r.workspace_id and k.run_id = r.id and k.stop_requested_at is not null)
    on conflict (workspace_id, run_id) do update
      set resume_requested_at = coalesce(c.resume_requested_at, now()),
          control_requested_by = excluded.control_requested_by
      where c.stop_requested_at is null;
  end if;

  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'accepted' else 'not_applicable' end;
end;
$$;

revoke all on function public.request_run_control(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_run_control(uuid, uuid, text) to authenticated;
comment on function public.request_run_control(uuid, uuid, text) is
  'AGO-86: a member asks to pause, resume or stop a run. Records the request only; the worker acts. Human session required, workspace scoped, never writes run_events or runs.';

-- AGO-58's event function, widened to the control route (same checks, own event code).
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
     and p_route ~ '^/api/runs/[0-9a-fA-F-]{36}/control$' then
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
-- create or replace keeps the AGO-58 grants (service_role only); restated so the file is self-checking.
revoke all on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  to service_role;
