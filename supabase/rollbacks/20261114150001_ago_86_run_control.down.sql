-- Rollback for AGO-86: restore AGO-58's approval-only event function, drop the control function and the three columns.
-- Run events already appended (error.raised with code control_route_rejected) stay: run_events is append-only by design.
drop function if exists public.request_run_control(uuid, uuid, text);

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
begin
  if p_workspace_id is null or p_run_id is null or p_agent_id is null or p_jti is null then
    raise exception 'record_agent_approval_rejection: ids are required' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE') then
    raise exception 'record_agent_approval_rejection: unsupported method' using errcode = '22023';
  end if;
  if p_route is null or char_length(p_route) > 400
     or not (p_route = '/api/approvals' or p_route like '/api/approvals/%') then
    raise exception 'record_agent_approval_rejection: not an approval route' using errcode = '22023';
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
      and e.payload ->> 'code' = 'approval_route_rejected'
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
      'code', 'approval_route_rejected',
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

alter table private.run_checkpoints
  drop column if exists control_requested_by,
  drop column if exists resume_requested_at,
  drop column if exists stop_requested_at;
