-- AGO-148: per-agent identity and short-lived scoped credentials (EP-17). Builds on AGO-74 (agents, runs,
-- agent_capabilities), AGO-125 (capabilities catalog), AGO-82 (private.is_member), AGO-107 (per-command RLS and
-- exact grants) and AGO-128 (the append-only trigger pattern).
-- Rollback: supabase/rollbacks/20261107130001_ago_148_agent_identity_credentials.down.sql
--
-- Decisions (full list in docs/tickets/AGO-148.md):
-- * public.agent_identities: one non-login principal per agent (never an auth user). Created by a trigger on
--   agents (and backfilled), never writable through the API.
-- * public.agent_credentials: the issuance log. One row per credential the worker issues for a run. The raw token
--   is never stored, only its SHA-256 hash. Rows are append-only for every role, service_role included, with one
--   exception: revoked_at may be set once (null -> timestamp) and nothing else may change.
-- * The database is the enforcer, not just the worker: a BEFORE INSERT trigger rejects a credential that lives
--   longer than 15 minutes, belongs to another agent or workspace, is for a run that has ended, or carries a
--   capability the agent was not granted (AC1, AC2). The worker computes the same values; this is defense in depth.
-- * A credential never raises a capability's tier: tier 3+ still needs an approval (the policy hook is unchanged).
-- * Credentials are revoked when the run leaves queued/running (trigger on runs), so a stopped or finished run
--   leaves no usable credential behind.

create table public.agent_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, agent_id),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade
);
comment on table public.agent_identities is 'One non-login principal per agent (AGO-148). Created by a trigger on agents; never writable through the API. Never an auth user.';

create table public.agent_credentials (
  id uuid primary key default gen_random_uuid(), -- the token's jti claim
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  run_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'), -- sha256 of the token; the token itself is never stored
  capabilities text[] not null default '{}'::text[], -- the granted-and-requested intersection the token carries
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (workspace_id, id),
  unique (token_hash),
  -- Mirrored by CREDENTIAL_MAX_TTL_SECONDS in packages/shared.
  constraint agent_credentials_max_ttl_check check (expires_at > issued_at and expires_at <= issued_at + interval '15 minutes'),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete no action,
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete no action
);
create index agent_credentials_workspace_run_idx on public.agent_credentials (workspace_id, run_id);
create index agent_credentials_workspace_agent_idx on public.agent_credentials (workspace_id, agent_id);
comment on table public.agent_credentials is 'Issuance log of short-lived agent credentials (AGO-148). Append-only; revoked_at may be set once. Holds the token hash, never the token.';

-- 1. Identities: one per agent, created with the agent.
create function private.create_agent_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.agent_identities (workspace_id, agent_id) values (new.workspace_id, new.id)
  on conflict (workspace_id, agent_id) do nothing;
  return null;
end
$$;
revoke all on function private.create_agent_identity() from public, anon, authenticated;
create trigger create_agent_identity after insert on public.agents
  for each row execute function private.create_agent_identity();
insert into public.agent_identities (workspace_id, agent_id)
select workspace_id, id from public.agents on conflict (workspace_id, agent_id) do nothing;

-- 2. Issuance checks (AC1, AC2), whatever the caller sends. SECURITY DEFINER: it reads tables the caller may not.
create function private.check_agent_credential_issue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record;
  v_ungranted text[];
begin
  select r.agent_id, r.status into v_run from public.runs r
   where r.workspace_id = new.workspace_id and r.id = new.run_id;
  if not found or v_run.agent_id is distinct from new.agent_id then
    raise exception 'credential run % does not belong to agent % in this workspace', new.run_id, new.agent_id
      using errcode = '42501';
  end if;
  if v_run.status not in ('queued', 'running') then
    raise exception 'no credential can be issued for a run that has ended' using errcode = '42501';
  end if;
  if abs(extract(epoch from (new.issued_at - now()))) > 30 then
    raise exception 'issued_at must be within 30 seconds of the database clock' using errcode = '42501';
  end if;
  new.revoked_at := null;
  -- A capability counts only when the agent holds it and the workspace catalog has it enabled.
  select coalesce(array_agg(c order by c), '{}') into v_ungranted
    from unnest(new.capabilities) as c
   where not exists (
     select 1 from public.agent_capabilities ac
       join public.capabilities cap on cap.workspace_id = ac.workspace_id and cap.key = ac.capability
      where ac.workspace_id = new.workspace_id and ac.agent_id = new.agent_id
        and ac.capability = c and cap.enabled);
  if cardinality(v_ungranted) > 0 then
    raise exception 'credential carries capabilities the agent lacks: %', v_ungranted using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.check_agent_credential_issue() from public, anon, authenticated;
create trigger check_agent_credential_issue before insert on public.agent_credentials
  for each row execute function private.check_agent_credential_issue();
alter table public.agent_credentials enable always trigger check_agent_credential_issue;

-- 3. Append-only for every role. The single allowed change: revoked_at null -> timestamp, nothing else.
create function private.agent_credentials_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.revoked_at is null and new.revoked_at is not null
     and (new.id, new.workspace_id, new.agent_id, new.run_id, new.token_hash, new.capabilities, new.issued_at, new.expires_at)
         is not distinct from
         (old.id, old.workspace_id, old.agent_id, old.run_id, old.token_hash, old.capabilities, old.issued_at, old.expires_at) then
    return new;
  end if;
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.workspaces w where w.id = old.workspace_id)
          or not exists (select 1 from public.agents a where a.id = old.agent_id)) then
    return old; -- the parent is already gone: this is the FK cascade
  end if;
  raise exception 'agent_credentials is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Only revoked_at may be set, once.';
end
$$;
revoke all on function private.agent_credentials_block_change() from public, anon, authenticated;
create trigger agent_credentials_block_update before update on public.agent_credentials
  for each row execute function private.agent_credentials_block_change();
create trigger agent_credentials_block_delete before delete on public.agent_credentials
  for each row execute function private.agent_credentials_block_change();
-- TRUNCATE skips row triggers and RLS: its own statement trigger, same pattern as AGO-102 and AGO-128.
create trigger agent_credentials_block_truncate before truncate on public.agent_credentials
  for each statement execute function private.agent_credentials_block_change();
alter table public.agent_credentials enable always trigger agent_credentials_block_update;
alter table public.agent_credentials enable always trigger agent_credentials_block_delete;
alter table public.agent_credentials enable always trigger agent_credentials_block_truncate;

-- 4. Revoke every live credential of a run when it ends (also covers the kill switch and a stopped run).
create function private.revoke_credentials_on_run_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('queued', 'running') and new.status not in ('queued', 'running') then
    update public.agent_credentials set revoked_at = now()
     where workspace_id = new.workspace_id and run_id = new.id and revoked_at is null;
  end if;
  return null;
end
$$;
revoke all on function private.revoke_credentials_on_run_end() from public, anon, authenticated;
create trigger revoke_credentials_on_run_end after update of status on public.runs
  for each row execute function private.revoke_credentials_on_run_end();

-- 5. RLS and grants: members read their workspace's log and identities; nobody writes through the API.
alter table public.agent_identities enable row level security;
alter table public.agent_credentials enable row level security;
revoke all on table public.agent_identities, public.agent_credentials from anon, authenticated;
grant select on public.agent_identities, public.agent_credentials to authenticated;
-- service_role bypasses RLS: it may append credentials and set revoked_at, never edit or empty the log.
revoke update, delete, truncate, trigger, references on table public.agent_credentials from public, anon, authenticated, service_role;
grant update (revoked_at) on public.agent_credentials to service_role;
revoke update, delete, truncate, trigger, references on table public.agent_identities from public, anon, authenticated, service_role;
create policy agent_identities_select_viewer on public.agent_identities for select to authenticated
  using (private.is_member(workspace_id));
create policy agent_credentials_select_viewer on public.agent_credentials for select to authenticated
  using (private.is_member(workspace_id));
