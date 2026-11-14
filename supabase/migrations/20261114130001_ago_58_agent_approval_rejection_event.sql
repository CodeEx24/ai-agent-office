-- AGO-58 (LOCAL DRAFT: do not push until the schema slot is granted; re-timestamp later than every migration then).
-- Appends one `error.raised` run event (code `approval_route_rejected`) when an agent credential calls a human-only
-- approval route.
--
-- Why a function: `run_events` is runtime-only (append-only, no role may write it directly) and the web app holds no
-- service role. The web layer verifies the token signature first, then calls this with a FIXED shape. The function
-- is the bound, so it checks everything it can without the token:
--   * the credential id (jti) must be a genuinely issued `agent_credentials` row for exactly this workspace, agent
--     and run (so it names a real run, never another workspace's);
--   * the route must be an approval route and the method one of the five the event allows;
--   * at most 20 such events per run per minute (an agent calling the function directly cannot flood the log);
--   * it only appends one event of one type. It reads, returns and changes nothing else.
-- SECURITY DEFINER, search_path = '', fully qualified (AGO-160 pattern).
--
-- Executable by service_role only (anon, authenticated and PUBLIC are revoked, as the repo's RLS invariant tests
-- require). The web layer calls it with the server-only SUPABASE_SERVICE_ROLE_KEY, after verifying the signature.

create function public.record_agent_approval_rejection(
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

  -- A genuinely issued credential for exactly this workspace, agent and run. Revoked or expired still counts: a
  -- stale token calling an approval route is exactly what the audit should show.
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

  -- Flood bound: stay quiet past 20 per run per minute (the 403 itself is unaffected).
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

  -- An existing `error.raised` event with a fixed code (the approved v1 event list is not amended). The message is
  -- built here from the validated method and route; nothing the caller sends reaches the payload unchecked.
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

comment on function public.record_agent_approval_rejection(uuid, uuid, uuid, uuid, text, text) is
  'AGO-58: appends one error.raised run event (code approval_route_rejected) for a genuinely issued agent credential. Fixed shape, flood-bounded, append only.';
