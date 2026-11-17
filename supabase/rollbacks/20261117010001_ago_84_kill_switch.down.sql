-- Rollback for AGO-84: drop the issuance latch, the two kill switch functions and the latch table, and restore
-- AGO-86's version of the event function (approval and run control routes only).
-- Credentials already revoked and run.stopped events already written stay: both logs are append-only by design.
-- Stop flags already set in private.run_checkpoints stay too (AGO-86's stop is final).
drop trigger if exists check_kill_switch_on_credential_issue on public.agent_credentials;
drop function if exists private.check_kill_switch_on_credential_issue();
drop function if exists public.release_kill_switch(uuid, text, uuid);
drop function if exists public.activate_kill_switch(uuid, text, uuid);

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
revoke all on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text)
  to service_role;

drop table if exists private.kill_switches;
