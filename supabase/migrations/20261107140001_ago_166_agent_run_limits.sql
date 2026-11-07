-- AGO-166: per-agent run limits. A nullable jsonb on agents holds an owner's overrides for the run guard rails
-- (steps, tokens, wall time). Null or a missing key = use the worker's defaults.
--
-- Rollback: supabase/rollbacks/20261107140001_ago_166_agent_run_limits.down.sql
--
-- Decisions:
-- * Bounds are enforced by a CHECK (private.run_limits_valid) that mirrors RUN_LIMIT_BOUNDS in
--   packages/shared/src/agents/run-limits.ts, so nobody can store "unlimited", even with the service role.
--   If the bounds change, change both in one ticket (a new migration replaces the function). The worker also
--   clamps on read, so a stale row can never raise a limit past the code's caps.
-- * Owner-only writes: a column grant cannot tell an owner from a member (both are `authenticated`), and
--   agents_update_member lets members update rows. So run_limits gets NO column grant at all, and owners write
--   it through public.set_agent_run_limits(), which checks the owner role. Members, viewers and agent
--   identities have no path to the column. Nothing else about agents' grants changes.
-- * The function is SECURITY DEFINER only because the column has no grant for the caller; it checks
--   private.is_member(workspace_id, 'owner') first and updates by (workspace_id, id), so it cannot cross
--   workspaces.

create function private.run_limits_valid(p_limits jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_limits) <> 'object' then false else not exists (
      select 1 from jsonb_each(p_limits) as e(key, value)
      where case
              when e.key not in ('maxSteps', 'maxTokens', 'maxWallMs') then true
              when jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[0-9]+$' then true
              when e.key = 'maxSteps' then (e.value::text)::numeric not between 1 and 200
              when e.key = 'maxTokens' then (e.value::text)::numeric not between 1000 and 5000000
              else (e.value::text)::numeric not between 1000 and 840000
            end
    ) end;
$$;
comment on function private.run_limits_valid(jsonb) is 'True for an object whose keys are maxSteps, maxTokens, maxWallMs with integer values inside RUN_LIMIT_BOUNDS (AGO-166).';

-- authenticated needs execute because the CHECK runs as the writing role (create_agent inserts as the caller).
revoke all on function private.run_limits_valid(jsonb) from public, anon;
grant execute on function private.run_limits_valid(jsonb) to authenticated;

alter table public.agents
  add column run_limits jsonb check (run_limits is null or private.run_limits_valid(run_limits));
comment on column public.agents.run_limits is 'Owner overrides for the run guard rails (AGO-166): maxSteps 1-200, maxTokens 1000-5000000, maxWallMs 1000-840000. Null = worker defaults. No column grant: written only through set_agent_run_limits().';

create function public.set_agent_run_limits(p_workspace_id uuid, p_agent_id uuid, p_limits jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can set run limits' using errcode = '42501';
  end if;
  if p_limits is not null and not private.run_limits_valid(p_limits) then
    raise exception 'run limits out of bounds' using errcode = '22023';
  end if;
  update public.agents set run_limits = p_limits
   where workspace_id = p_workspace_id and id = p_agent_id and archived_at is null;
  if not found then
    raise exception 'agent not found in this workspace' using errcode = 'P0002';
  end if;
end;
$$;
comment on function public.set_agent_run_limits(uuid, uuid, jsonb) is 'Owners set or clear (null) one agent''s run limits (AGO-166). Validated by the CHECK on agents.run_limits.';
revoke all on function public.set_agent_run_limits(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_agent_run_limits(uuid, uuid, jsonb) to authenticated;
