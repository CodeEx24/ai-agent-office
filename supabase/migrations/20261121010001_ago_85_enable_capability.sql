-- AGO-85: a risky capability (code.run, web.browse, message.send_outbound) cannot be turned on while a prerequisite
-- check fails. Decisions (record: docs/tickets/AGO-85.md): owner picked an attestation table the worker writes and a
-- SECURITY DEFINER enable function that reads it.
--
-- * capability_prerequisite_status: one row per workspace and check (sandbox_hardened, egress_default_deny,
--   credential_broker, approval_payload_hash) holding the worker's last result (status + fixed reason code + time).
--   Authenticated users may read it (members only); nobody but the worker (service_role) writes it.
-- * public.enable_capability(): the only way to turn a capability on through the API. Owner only (an agent credential
--   has no auth.uid() or member, so it is refused). For a gated key it refuses unless every required check is 'pass'
--   and was recorded in the last 60 seconds. A missing, failing, errored, timed out, not-run or stale row is a refusal
--   (fail closed). The required checks per key live in private.capability_prerequisite_checks(); the worker-side
--   map (packages/shared) is compared with it by a Vitest drift test.
-- * public.disable_capability(): turning a capability off needs no check, so owners keep that; same owner guard.
-- * `capabilities.enabled` leaves the UPDATE grant of authenticated (description stays editable) and service_role
--   loses UPDATE on the table, so no API caller can flip the flag directly.
--   Limit: the table owner and superusers (infrastructure access) can still write the column; the worker's tool-call
--   gate (AGO-85) denies a risky capability whose checks fail even then.

-- 1. The attestation table.
create table public.capability_prerequisite_status (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  check_name text not null
    check (check_name in ('sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash')),
  status text not null check (status in ('pass', 'fail', 'error', 'timeout', 'not_run')),
  reason text check (reason is null or reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, check_name)
);
create trigger set_updated_at before update on public.capability_prerequisite_status
  for each row execute function private.set_updated_at();
comment on table public.capability_prerequisite_status is 'The worker''s last prerequisite check results per workspace (AGO-85). Written only by the worker (service_role); enable_capability() reads it and refuses on a missing, failing or stale row. Status and a fixed reason code only, never error text.';
alter table public.capability_prerequisite_status enable row level security;
revoke all on table public.capability_prerequisite_status from public, anon, authenticated, service_role;
grant select on public.capability_prerequisite_status to authenticated;
grant select, insert, update on public.capability_prerequisite_status to service_role;
create policy capability_prerequisite_status_select_member on public.capability_prerequisite_status for select to authenticated
  using (private.is_member(workspace_id));

-- 2. Which checks a capability key needs. An ungated key needs none.
create function private.capability_prerequisite_checks(p_key text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'code.run' then array['sandbox_hardened', 'credential_broker', 'approval_payload_hash']
    when 'web.browse' then array['sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash']
    when 'message.send_outbound' then array['egress_default_deny', 'credential_broker', 'approval_payload_hash']
    else array[]::text[]
  end;
$$;
revoke all on function private.capability_prerequisite_checks(text) from public, anon, authenticated, service_role;

-- 3. Enable: owner only, re-checks the attestation, fails closed.
create function public.enable_capability(p_workspace_id uuid, p_capability_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_enabled boolean;
  v_check text;
begin
  if auth.uid() is null or not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can enable a capability' using errcode = '42501';
  end if;

  select key, enabled into v_key, v_enabled
    from public.capabilities where workspace_id = p_workspace_id and id = p_capability_id
    for update;
  if not found then
    raise exception 'capability not found in this workspace' using errcode = 'P0002';
  end if;
  if v_enabled then
    return;
  end if;

  foreach v_check in array private.capability_prerequisite_checks(v_key) loop
    if not exists (
      select 1 from public.capability_prerequisite_status s
       where s.workspace_id = p_workspace_id and s.check_name = v_check and s.status = 'pass'
         and s.checked_at > now() - interval '60 seconds' and s.checked_at <= now() + interval '5 seconds'
    ) then
      raise exception 'prerequisite check not passing: %', v_check using errcode = '55000';
    end if;
  end loop;

  update public.capabilities set enabled = true where workspace_id = p_workspace_id and id = p_capability_id;
end;
$$;
comment on function public.enable_capability(uuid, uuid) is 'Owners turn a capability on (AGO-85). A gated key needs every required prerequisite attested as pass within 60 seconds; a missing, failing or stale row refuses (55000). Agent credentials and service_role cannot call it.';
revoke all on function public.enable_capability(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.enable_capability(uuid, uuid) to authenticated;

-- 4. Disable: no check needed to turn something off.
create function public.disable_capability(p_workspace_id uuid, p_capability_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can disable a capability' using errcode = '42501';
  end if;
  update public.capabilities set enabled = false where workspace_id = p_workspace_id and id = p_capability_id;
  if not found then
    raise exception 'capability not found in this workspace' using errcode = 'P0002';
  end if;
end;
$$;
comment on function public.disable_capability(uuid, uuid) is 'Owners turn a capability off (AGO-85). No prerequisite check: turning off is always allowed. Agent credentials and service_role cannot call it.';
revoke all on function public.disable_capability(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.disable_capability(uuid, uuid) to authenticated;

-- 5. Close the direct route: enabled is no longer writable through the API.
revoke update (enabled, description) on public.capabilities from authenticated;
grant update (description) on public.capabilities to authenticated;
revoke update on public.capabilities from service_role;
