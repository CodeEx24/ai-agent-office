-- AGO-160: task claims with expiry. One agent owns a task at a time; a claim that is not renewed expires.
--
-- Rollback: supabase/rollbacks/20261114010001_ago_160_task_claims.down.sql
--
-- Decisions (record: docs/tickets/AGO-160.md):
-- * Builds on public.claims (AGO-74). Its partial unique index (one row per task with released_at is null) is the
--   atomic backstop: claim_task does a conditional INSERT ... ON CONFLICT DO NOTHING, so two concurrent claimers can
--   never both win and there is no check-then-act in application code.
-- * Expiry is judged by the database clock (now()), never a worker clock. claim_task first releases an expired
--   claim on the task (lazy expiry), then inserts; sweep_expired_claims frees abandoned claims in bulk.
-- * claim_token is the fence. It is new on every claim, never logged, and not readable through the Data API
--   (column-level select without it). renew_claim and release_claim (release or complete) need it, so the old holder
--   of a taken-over claim can no longer renew or complete.
-- * The four functions are SECURITY DEFINER, search_path = '', fully qualified, and executable by service_role only.
--   People and agent tokens (anon, authenticated) cannot call them: an agent never claims on behalf of anyone.
-- * Every state change appends a row to public.claim_events (append-only, same guard as run_events). task_id,
--   claim_id and agent_id there are plain uuids with no foreign key, so the audit trail outlives a deleted task.
-- * tasks.status is not touched (owned by other tickets). A claim is separate ownership state.
-- * "Active agent" means not archived: agents.status is free text with no vocabulary yet, so it is not judged here.

-- 1. Claim columns.
alter table public.claims
  add column claim_token uuid not null default gen_random_uuid(),
  add column renewed_at timestamptz,
  add column release_reason text;
comment on column public.claims.claim_token is 'Fence token (AGO-160). New on every claim; required to renew, release or complete. Never logged, not readable by anon or authenticated.';
comment on column public.claims.release_reason is 'Why the claim ended: released, completed, expired_takeover or expired_sweep. Null while the claim is active.';

-- Rows from before this ticket: give every row an expiry and every ended row a reason.
update public.claims set expires_at = claimed_at + interval '5 minutes' where expires_at is null;
update public.claims set release_reason = 'released' where released_at is not null and release_reason is null;

alter table public.claims
  alter column expires_at set default (now() + interval '5 minutes'),
  alter column expires_at set not null,
  add constraint claims_expires_after_claimed check (expires_at > claimed_at),
  add constraint claims_release_reason_values
    check (release_reason is null or release_reason in ('released', 'completed', 'expired_takeover', 'expired_sweep')),
  add constraint claims_release_reason_matches_release check ((released_at is null) = (release_reason is null));

-- Members keep reading claims, but not the fence token.
revoke select on public.claims from authenticated;
grant select (id, workspace_id, task_id, agent_id, run_id, claimed_at, expires_at, released_at, release_reason,
              renewed_at, created_at, updated_at)
  on public.claims to authenticated;

-- 2. Append-only audit trail.
create table public.claim_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null,
  claim_id uuid not null,
  agent_id uuid not null,
  type text not null check (type in ('claim.acquired', 'claim.renewed', 'claim.released', 'claim.completed', 'claim.expired')),
  payload jsonb not null default '{}'::jsonb, -- never contains the claim token or any secret
  created_at timestamptz not null default now()
);
comment on table public.claim_events is 'Append-only audit trail of task claims (AGO-160). Written only by the claim functions, in the same transaction as the change. UPDATE and DELETE are blocked for every role.';
create index claim_events_workspace_task_idx on public.claim_events (workspace_id, task_id, created_at);
create index claim_events_workspace_claim_idx on public.claim_events (workspace_id, claim_id);
alter table public.claim_events enable row level security;

create function private.claim_events_block_change()
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
  raise exception 'claim_events is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Insert a new event instead.';
end;
$$;
revoke all on function private.claim_events_block_change() from public, anon, authenticated;
create trigger claim_events_block_update_delete before update or delete on public.claim_events
  for each row execute function private.claim_events_block_change();
create trigger claim_events_block_truncate before truncate on public.claim_events
  for each statement execute function private.claim_events_block_change();
alter table public.claim_events enable always trigger claim_events_block_update_delete;
alter table public.claim_events enable always trigger claim_events_block_truncate;

revoke all on table public.claim_events from public, anon, authenticated, service_role;
grant select on public.claim_events to authenticated, service_role;
create policy claim_events_select_viewer on public.claim_events for select to authenticated
  using (private.is_member(workspace_id));

create function private.log_claim_event(
  p_workspace_id uuid, p_task_id uuid, p_claim_id uuid, p_agent_id uuid, p_type text, p_payload jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.claim_events (workspace_id, task_id, claim_id, agent_id, type, payload)
  values (p_workspace_id, p_task_id, p_claim_id, p_agent_id, p_type, p_payload);
$$;
revoke all on function private.log_claim_event(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- 3. claim_task: take a task, or say exactly why not. Outcomes: 'claimed', 'held', 'refused' (with a reason).
--    refused reasons: invalid_ttl, task_not_found, agent_not_found, workspace_mismatch, agent_archived, run_mismatch.
--    The token is returned only to the caller that won; 'held' reveals the holder and expiry, never the token.
create function public.claim_task(
  p_workspace_id uuid,
  p_task_id uuid,
  p_agent_id uuid,
  p_run_id uuid default null,
  p_ttl_seconds integer default 300
)
returns table (
  outcome text, reason text, claim_id uuid, claim_token uuid, expires_at timestamptz, holder_agent_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_workspace uuid;
  v_agent_workspace uuid;
  v_archived_at timestamptz;
  v_claim public.claims;
  v_expired record;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 10 or p_ttl_seconds > 3600 then
    return query select 'refused'::text, 'invalid_ttl'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;

  select t.workspace_id into v_task_workspace from public.tasks t where t.id = p_task_id;
  if v_task_workspace is null then
    return query select 'refused'::text, 'task_not_found'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;
  -- FOR SHARE: a concurrent archive of this agent waits for the claim (or the claim sees the archive).
  select a.workspace_id, a.archived_at into v_agent_workspace, v_archived_at
    from public.agents a where a.id = p_agent_id for share;
  if v_agent_workspace is null then
    return query select 'refused'::text, 'agent_not_found'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;
  if v_task_workspace <> p_workspace_id or v_agent_workspace <> p_workspace_id then
    return query select 'refused'::text, 'workspace_mismatch'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;
  if v_archived_at is not null then
    return query select 'refused'::text, 'agent_archived'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;
  if p_run_id is not null and not exists (
       select 1 from public.runs r
        where r.workspace_id = p_workspace_id and r.id = p_run_id and r.agent_id = p_agent_id) then
    return query select 'refused'::text, 'run_mismatch'::text, null::uuid, null::uuid, null::timestamptz, null::uuid;
    return;
  end if;

  -- Lazy expiry (database clock): free an expired claim on this task, then insert. A concurrent taker waits on the
  -- row lock, sees the row already released, and loses at the insert below.
  for v_expired in
    update public.claims c
       set released_at = now(), release_reason = 'expired_takeover'
     where c.task_id = p_task_id and c.workspace_id = p_workspace_id
       and c.released_at is null and c.expires_at <= now()
    returning c.id, c.agent_id, c.expires_at
  loop
    perform private.log_claim_event(p_workspace_id, p_task_id, v_expired.id, v_expired.agent_id, 'claim.expired',
      jsonb_build_object('cause', 'takeover', 'expired_at', v_expired.expires_at, 'taken_by_agent_id', p_agent_id));
  end loop;

  insert into public.claims as c (workspace_id, task_id, agent_id, run_id, claimed_at, expires_at)
  values (p_workspace_id, p_task_id, p_agent_id, p_run_id, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (task_id) where released_at is null do nothing
  returning c.* into v_claim;

  if v_claim.id is null then
    return query
      select 'held'::text, 'task_already_claimed'::text, null::uuid, null::uuid, c.expires_at, c.agent_id
        from public.claims c
       where c.task_id = p_task_id and c.workspace_id = p_workspace_id and c.released_at is null;
    return;
  end if;

  perform private.log_claim_event(p_workspace_id, p_task_id, v_claim.id, p_agent_id, 'claim.acquired',
    jsonb_build_object('run_id', p_run_id, 'ttl_seconds', p_ttl_seconds, 'expires_at', v_claim.expires_at));
  return query select 'claimed'::text, null::text, v_claim.id, v_claim.claim_token, v_claim.expires_at, p_agent_id;
end;
$$;

-- 4. renew_claim: only the current holder, with the current token, before expiry.
--    refused reasons: invalid_ttl, claim_not_found, stale_token, claim_released, claim_expired.
create function public.renew_claim(
  p_workspace_id uuid,
  p_claim_id uuid,
  p_claim_token uuid,
  p_ttl_seconds integer default 300
)
returns table (outcome text, reason text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.claims;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 10 or p_ttl_seconds > 3600 then
    return query select 'refused'::text, 'invalid_ttl'::text, null::timestamptz;
    return;
  end if;

  update public.claims c
     set expires_at = now() + make_interval(secs => p_ttl_seconds), renewed_at = now()
   where c.workspace_id = p_workspace_id and c.id = p_claim_id and c.claim_token = p_claim_token
     and c.released_at is null and c.expires_at > now()
  returning c.* into v_claim;

  if v_claim.id is not null then
    perform private.log_claim_event(p_workspace_id, v_claim.task_id, v_claim.id, v_claim.agent_id, 'claim.renewed',
      jsonb_build_object('ttl_seconds', p_ttl_seconds, 'expires_at', v_claim.expires_at));
    return query select 'renewed'::text, null::text, v_claim.expires_at;
    return;
  end if;

  select c.* into v_claim from public.claims c where c.workspace_id = p_workspace_id and c.id = p_claim_id;
  return query select 'refused'::text,
    (case
       when v_claim.id is null then 'claim_not_found'
       when v_claim.claim_token <> p_claim_token then 'stale_token'
       when v_claim.release_reason in ('expired_takeover', 'expired_sweep') then 'claim_expired'
       when v_claim.released_at is not null then 'claim_released'
       else 'claim_expired'
     end)::text,
    null::timestamptz;
end;
$$;

-- 5. release_claim: the holder gives the task back ('released') or finishes it ('completed'), with the current
--    token. An expired claim that nobody has taken yet may still be ended by its holder; once another agent took
--    it the row is released and the old token is refused.
--    refused reasons: invalid_reason, claim_not_found, stale_token, claim_released, claim_expired.
create function public.release_claim(
  p_workspace_id uuid,
  p_claim_id uuid,
  p_claim_token uuid,
  p_reason text default 'released'
)
returns table (outcome text, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.claims;
  v_was_expired boolean;
begin
  if p_reason is null or p_reason not in ('released', 'completed') then
    return query select 'refused'::text, 'invalid_reason'::text;
    return;
  end if;

  -- Judge expiry before the update: now() is the transaction time and the row still holds its old expires_at.
  select c.expires_at <= now() into v_was_expired
    from public.claims c
   where c.workspace_id = p_workspace_id and c.id = p_claim_id and c.claim_token = p_claim_token
     and c.released_at is null;

  update public.claims c
     set released_at = now(), release_reason = p_reason
   where c.workspace_id = p_workspace_id and c.id = p_claim_id and c.claim_token = p_claim_token
     and c.released_at is null
  returning c.* into v_claim;

  if v_claim.id is not null then
    perform private.log_claim_event(p_workspace_id, v_claim.task_id, v_claim.id, v_claim.agent_id,
      case when p_reason = 'completed' then 'claim.completed' else 'claim.released' end,
      jsonb_build_object('after_expiry', coalesce(v_was_expired, false)));
    return query select (case when p_reason = 'completed' then 'completed' else 'released' end)::text, null::text;
    return;
  end if;

  select c.* into v_claim from public.claims c where c.workspace_id = p_workspace_id and c.id = p_claim_id;
  return query select 'refused'::text,
    (case
       when v_claim.id is null then 'claim_not_found'
       when v_claim.claim_token <> p_claim_token then 'stale_token'
       when v_claim.release_reason in ('expired_takeover', 'expired_sweep') then 'claim_expired'
       else 'claim_released'
     end)::text;
end;
$$;

-- 6. sweep_expired_claims: free every claim past its expiry (one workspace, or all when null). Returns the count.
create function public.sweep_expired_claims(p_workspace_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_expired record;
begin
  for v_expired in
    update public.claims c
       set released_at = now(), release_reason = 'expired_sweep'
     where c.released_at is null and c.expires_at <= now()
       and (p_workspace_id is null or c.workspace_id = p_workspace_id)
    returning c.id, c.workspace_id, c.task_id, c.agent_id, c.expires_at
  loop
    perform private.log_claim_event(v_expired.workspace_id, v_expired.task_id, v_expired.id, v_expired.agent_id,
      'claim.expired', jsonb_build_object('cause', 'sweep', 'expired_at', v_expired.expires_at));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 7. EXECUTE: service_role only.
revoke all on function public.claim_task(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.renew_claim(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_claim(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sweep_expired_claims(uuid) from public, anon, authenticated;
grant execute on function public.claim_task(uuid, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.renew_claim(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.release_claim(uuid, uuid, uuid, text) to service_role;
grant execute on function public.sweep_expired_claims(uuid) to service_role;

comment on function public.claim_task(uuid, uuid, uuid, uuid, integer) is 'Worker only (service_role). Atomically take a task for an agent, or return held/refused with a reason (AGO-160).';
comment on function public.renew_claim(uuid, uuid, uuid, integer) is 'Worker only (service_role). Extend a live claim; needs the current claim_token (AGO-160).';
comment on function public.release_claim(uuid, uuid, uuid, text) is 'Worker only (service_role). Release or complete a claim; needs the current claim_token (AGO-160).';
comment on function public.sweep_expired_claims(uuid) is 'Worker only (service_role). Free every expired claim and log it (AGO-160).';
