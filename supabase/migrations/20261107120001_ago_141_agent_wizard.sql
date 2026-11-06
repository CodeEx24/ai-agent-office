-- AGO-141: agent creation wizard. Role, model, prompt and a daily budget on agents; a per-grant mode on
-- agent_capabilities; owner-only creation; and public.create_agent(), one transaction that creates the agent,
-- its skill assignments and its capability grants together.
--
-- DRAFT: not applied to any database until the coordinator grants the schema slot (AGO-151 holds it). The
-- timestamp is renamed to the next free one on rebase.
-- Rollback: supabase/rollbacks/20261107120001_ago_141_agent_wizard.down.sql
--
-- Decisions:
-- * Daily budget is a column on agents (daily_budget_cents), not a budgets_usage row: budgets_usage is a per
--   period usage ledger (one row per agent and period, written by the runtime); a daily limit is a setting of
--   the agent, and the runtime can read it without a join. The cap (5000 cents) mirrors
--   AGENT_DAILY_BUDGET_MAX_CENTS in packages/shared; there is no per-workspace cap row yet.
-- * agent_capabilities.mode records how a grant runs. Tier 3 and 4 are always 'approval' (CHECK), so a tampered
--   request cannot make them automatic.
-- * create_agent is SECURITY INVOKER: row-level security stays the enforcement point and no privilege is
--   widened. It also checks the owner role itself so the failure is a clear error, not a policy violation.

alter table public.agents
  add column role text not null default '' check (char_length(role) <= 120),
  add column model text not null default '' check (char_length(model) <= 100),
  add column prompt text not null default '' check (char_length(prompt) <= 20000),
  add column daily_budget_cents integer check (daily_budget_cents between 1 and 5000);
comment on column public.agents.role is 'What the agent does, set in the creation wizard (AGO-141). Free text, untrusted display data.';
comment on column public.agents.model is 'Model id from the static allowlist in packages/shared (AGO-141). Not validated here: the allowlist changes without a migration.';
comment on column public.agents.prompt is 'The agent''s system prompt (AGO-141). Untrusted text; never grants a capability.';
comment on column public.agents.daily_budget_cents is 'Daily spend limit in US cents (AGO-141), 1 to 5000. Null = not set (agents created before the wizard).';

alter table public.agent_capabilities
  add column mode text not null default 'approval' check (mode in ('automatic', 'approval')),
  add constraint agent_capabilities_high_tier_never_automatic check (tier < 3 or mode = 'approval');
comment on column public.agent_capabilities.mode is 'automatic or approval (AGO-141). Never automatic at tier 3 or 4 (CHECK). The policy engine still decides per call.';

-- Owners hire agents. Members and viewers can still read them. The new columns are writable on insert only
-- (editing is AGO-89). mode, status and department_id stay out of every grant: an agent always starts strict.
drop policy if exists agents_insert_member on public.agents;
create policy agents_insert_owner on public.agents for insert to authenticated
  with check (private.is_member(workspace_id, 'owner'));
revoke insert on public.agents from authenticated;
grant insert (workspace_id, name, description, role, model, prompt, daily_budget_cents)
  on public.agents to authenticated;

revoke insert on public.agent_capabilities from authenticated;
grant insert (workspace_id, agent_id, capability, tier, mode, granted_by)
  on public.agent_capabilities to authenticated;

create function public.create_agent(
  p_workspace_id uuid,
  p_name text,
  p_role text,
  p_model text,
  p_prompt text,
  p_daily_budget_cents integer,
  p_skill_ids uuid[],
  p_capabilities jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_agent_id uuid;
  v_member_id uuid;
  v_skill_ids uuid[] := coalesce(p_skill_ids, '{}');
  v_cap jsonb;
  v_key text;
  v_mode text;
  v_tier smallint;
  v_enabled boolean;
begin
  if not private.is_member(p_workspace_id, 'owner') then
    raise exception 'only workspace owners can create agents' using errcode = '42501';
  end if;
  v_member_id := private.current_member_id(p_workspace_id);

  if p_daily_budget_cents is null or p_daily_budget_cents < 1 or p_daily_budget_cents > 5000 then
    raise exception 'daily budget must be between 1 and 5000 cents' using errcode = '22023';
  end if;
  if p_capabilities is not null and jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'capabilities must be an array' using errcode = '22023';
  end if;

  -- Every skill must be in this workspace (the composite FK repeats this, but a clear error helps).
  if (select count(*) from public.skills
      where workspace_id = p_workspace_id and id = any (v_skill_ids))
     <> (select count(distinct s) from unnest(v_skill_ids) as s) then
    raise exception 'a skill does not exist in this workspace' using errcode = 'P0002';
  end if;

  -- mode is not in any grant: the column default ('strict') is the only value an API caller can get.
  insert into public.agents (workspace_id, name, role, model, prompt, daily_budget_cents)
  values (p_workspace_id, p_name, p_role, p_model, p_prompt, p_daily_budget_cents)
  returning id into v_agent_id;

  insert into public.agent_skills (workspace_id, agent_id, skill_id)
  select p_workspace_id, v_agent_id, s from (select distinct unnest(v_skill_ids) as s) as skills_in;

  for v_cap in select * from jsonb_array_elements(coalesce(p_capabilities, '[]'::jsonb)) loop
    v_key := v_cap ->> 'key';
    v_mode := v_cap ->> 'mode';
    if v_key is null or v_mode not in ('automatic', 'approval') then
      raise exception 'invalid capability entry' using errcode = '22023';
    end if;
    select tier, enabled into v_tier, v_enabled
      from public.capabilities where workspace_id = p_workspace_id and key = v_key;
    if not found or not v_enabled then
      raise exception 'capability % is not available in this workspace', v_key using errcode = 'P0002';
    end if;
    if v_tier >= 3 and v_mode <> 'approval' then
      raise exception 'capability % (tier %) always needs approval', v_key, v_tier using errcode = '22023';
    end if;
    -- The tier is read from the catalog above, never from the caller.
    insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode, granted_by)
    values (p_workspace_id, v_agent_id, v_key, v_tier, v_mode, v_member_id)
    on conflict (agent_id, capability) do nothing;
  end loop;

  return v_agent_id;
end;
$$;
comment on function public.create_agent(uuid, text, text, text, text, integer, uuid[], jsonb) is 'Creates an agent (always strict), its skill assignments and capability grants in one transaction. Owners only (AGO-141).';
revoke all on function public.create_agent(uuid, text, text, text, text, integer, uuid[], jsonb)
  from public, anon;
grant execute on function public.create_agent(uuid, text, text, text, text, integer, uuid[], jsonb)
  to authenticated;
