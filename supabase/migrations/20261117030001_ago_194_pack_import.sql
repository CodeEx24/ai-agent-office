-- AGO-194: import an agent pack into a workspace, all or nothing (epic EP-19).
--
-- Rollback: supabase/rollbacks/20261117030001_ago_194_pack_import.down.sql
--
-- Decisions (record: docs/tickets/AGO-194.md):
-- * pack_events gains kind 'import' and a detail jsonb (counts and per-agent outcome, never pack text). An import may
--   touch no agent at all (every item skipped), so agent_ids may be empty for an import; an export keeps 1..100.
-- * public.import_agent_pack() is the one writer. It is SECURITY DEFINER with an empty search_path, and it protects
--   itself: it needs a signed-in person (auth.uid() is null for an agent token or the service role), the owner role
--   in the named workspace, and it only ever touches rows of that workspace. One call is one transaction: any error
--   leaves no agent, skill, grant or event behind.
-- * It never sets a mode (every new agent gets the column default, strict: that is the probation), reads capability
--   tiers from the workspace catalog (never from the plan), grants only approval mode and refuses Tier 3 or higher.
--   An agent flagged disabled_reason is created and archived in the same transaction.
-- * A plan that no longer matches the workspace (a name now exists, or an agent to update is gone or archived) is a
--   stale plan: SQLSTATE 40001, nothing written.

alter table public.pack_events add column detail jsonb;
alter table public.pack_events add constraint pack_events_detail_object
  check (detail is null or jsonb_typeof(detail) = 'object');

-- The old checks are looked up by definition, not by a guessed name.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.pack_events'::regclass
       and c.contype = 'c'
       and (pg_get_constraintdef(c.oid) like '%kind%'
            or pg_get_constraintdef(c.oid) like '%cardinality(agent_ids)%')
       and c.conname <> 'pack_events_detail_object'
  loop
    execute format('alter table public.pack_events drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.pack_events add constraint pack_events_kind_check check (kind in ('export', 'import'));
alter table public.pack_events add constraint pack_events_agent_ids_check check (
  (kind = 'export' and cardinality(agent_ids) between 1 and 100)
  or (kind = 'import' and cardinality(agent_ids) between 0 and 100)
);

comment on column public.pack_events.detail is 'Import only (AGO-194): the conflict rule, counts and the per-agent outcome. Never pack text or secrets.';

create function public.import_agent_pack(
  p_workspace_id uuid,
  p_checksum text,
  p_plan jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_member_id uuid;
  v_rule text;
  v_skill jsonb;
  v_agent jsonb;
  v_cap text;
  v_name text;
  v_skill_id uuid;
  v_agent_id uuid;
  v_existing_archived timestamptz;
  v_tier smallint;
  v_enabled boolean;
  v_budget integer;
  v_agent_ids uuid[] := '{}';
  v_agent_names text[] := '{}';
  v_outcomes jsonb := '[]'::jsonb;
  v_skills_written integer := 0;
  v_disabled integer := 0;
  v_event_id uuid;
begin
  -- Human only: a real person's session, never a token that carries an agent claim.
  if v_user is null
     or coalesce(v_claims ->> 'role', '') <> 'authenticated'
     or v_claims ?| array['agent_id', 'run_id', 'agent_credential'] then
    raise exception 'import_agent_pack: a human session is required' using errcode = '42501';
  end if;
  if p_workspace_id is null or not private.is_member(p_workspace_id, 'owner') then
    raise exception 'import_agent_pack: not allowed' using errcode = '42501';
  end if;
  v_member_id := private.current_member_id(p_workspace_id);
  if v_member_id is null then
    raise exception 'import_agent_pack: not allowed' using errcode = '42501';
  end if;

  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'import_agent_pack: invalid checksum' using errcode = '22023';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object'
     or jsonb_typeof(p_plan -> 'agents') is distinct from 'array'
     or jsonb_typeof(p_plan -> 'skills') is distinct from 'array' then
    raise exception 'import_agent_pack: invalid plan' using errcode = '22023';
  end if;
  v_rule := p_plan ->> 'rule';
  if v_rule is null or v_rule not in ('skip', 'rename', 'new_version') then
    raise exception 'import_agent_pack: invalid conflict rule' using errcode = '22023';
  end if;
  if jsonb_array_length(p_plan -> 'agents') > 100 or jsonb_array_length(p_plan -> 'skills') > 500 then
    raise exception 'import_agent_pack: plan too large' using errcode = '22023';
  end if;

  -- Two imports into one workspace run one after the other.
  perform pg_advisory_xact_lock(hashtextextended('import_agent_pack:' || p_workspace_id::text, 0));

  -- Skills first, so an agent can point at them. A new skill is version 1; a new version updates the body and the
  -- existing triggers bump the version and append to the history. Nothing is ever overwritten silently.
  for v_skill in select * from jsonb_array_elements(p_plan -> 'skills') loop
    v_name := v_skill ->> 'name';
    if v_name is null or char_length(v_name) not between 1 and 120
       or jsonb_typeof(v_skill -> 'body') is distinct from 'string'
       or (v_skill ->> 'action') not in ('create', 'new_version') then
      raise exception 'import_agent_pack: invalid skill entry' using errcode = '22023';
    end if;
    if (v_skill ->> 'action') = 'create' then
      if exists (select 1 from public.skills s where s.workspace_id = p_workspace_id and s.name = v_name) then
        raise exception 'import_agent_pack: a skill now exists' using errcode = '40001';
      end if;
      insert into public.skills (workspace_id, name, body) values (p_workspace_id, v_name, v_skill ->> 'body');
    else
      update public.skills s set body = v_skill ->> 'body'
       where s.workspace_id = p_workspace_id and s.name = v_name;
      if not found then
        raise exception 'import_agent_pack: a skill to version is gone' using errcode = '40001';
      end if;
    end if;
    v_skills_written := v_skills_written + 1;
  end loop;

  for v_agent in select * from jsonb_array_elements(p_plan -> 'agents') loop
    v_name := v_agent ->> 'name';
    v_budget := (v_agent ->> 'daily_budget_cents')::integer;
    if v_name is null or char_length(v_name) not between 1 and 120
       or (v_agent ->> 'action') not in ('create', 'update')
       or jsonb_typeof(v_agent -> 'capabilities') is distinct from 'array'
       or jsonb_typeof(v_agent -> 'skills') is distinct from 'array'
       or v_budget is null or v_budget < 1 or v_budget > 5000 then
      raise exception 'import_agent_pack: invalid agent entry' using errcode = '22023';
    end if;

    if (v_agent ->> 'action') = 'create' then
      if exists (select 1 from public.agents a where a.workspace_id = p_workspace_id and a.name = v_name) then
        raise exception 'import_agent_pack: an agent now exists' using errcode = '40001';
      end if;
      -- No mode in the column list: the default (strict) is the only value an import can give.
      insert into public.agents (workspace_id, name, role, model, thinking_effort, prompt, daily_budget_cents)
      values (p_workspace_id, v_name, v_agent ->> 'role', v_agent ->> 'model', v_agent ->> 'thinking_effort',
              v_agent ->> 'prompt', v_budget)
      returning id into v_agent_id;
    else
      v_agent_id := null;
      select a.id, a.archived_at into v_agent_id, v_existing_archived
        from public.agents a where a.workspace_id = p_workspace_id and a.name = v_name for update;
      if v_agent_id is null or v_existing_archived is not null then
        raise exception 'import_agent_pack: an agent to update is gone or archived' using errcode = '40001';
      end if;
      -- The mode, status and archive state are never part of an update.
      update public.agents
         set role = v_agent ->> 'role', model = v_agent ->> 'model', thinking_effort = v_agent ->> 'thinking_effort',
             prompt = v_agent ->> 'prompt', daily_budget_cents = v_budget
       where workspace_id = p_workspace_id and id = v_agent_id;
    end if;

    -- Skills by name, within this workspace only.
    for v_name in select jsonb_array_elements_text(v_agent -> 'skills') loop
      v_skill_id := null;
      select s.id into v_skill_id from public.skills s where s.workspace_id = p_workspace_id and s.name = v_name;
      if v_skill_id is null then
        raise exception 'import_agent_pack: a skill does not exist in this workspace' using errcode = 'P0002';
      end if;
      insert into public.agent_skills (workspace_id, agent_id, skill_id)
      values (p_workspace_id, v_agent_id, v_skill_id)
      on conflict (agent_id, skill_id) do nothing;
    end loop;

    -- Capabilities: the tier comes from the workspace catalog, never from the plan. Approval mode only, below Tier 3.
    for v_cap in select jsonb_array_elements_text(v_agent -> 'capabilities') loop
      select c.tier, c.enabled into v_tier, v_enabled
        from public.capabilities c where c.workspace_id = p_workspace_id and c.key = v_cap;
      if not found or not v_enabled then
        raise exception 'import_agent_pack: a capability is not available in this workspace' using errcode = 'P0002';
      end if;
      if v_tier >= 3 then
        raise exception 'import_agent_pack: a capability changed to Tier 3 or higher' using errcode = '40001';
      end if;
      insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode, granted_by)
      values (p_workspace_id, v_agent_id, v_cap, v_tier, 'approval', v_member_id)
      on conflict (agent_id, capability) do nothing;
    end loop;

    -- A failed trifecta lint: imported, then disabled (archived) in the same transaction, with the reason on record.
    if nullif(v_agent ->> 'disabled_reason', '') is not null then
      update public.agents set archived_at = now() where workspace_id = p_workspace_id and id = v_agent_id;
      v_disabled := v_disabled + 1;
    end if;

    v_agent_ids := v_agent_ids || v_agent_id;
    v_agent_names := v_agent_names || (v_agent ->> 'name');
    v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
      'name', v_agent ->> 'name',
      'action', v_agent ->> 'action',
      'disabled_reason', nullif(v_agent ->> 'disabled_reason', '')
    ));
  end loop;

  insert into public.pack_events (
    workspace_id, kind, exported_by, agent_ids, agent_names, skill_count, checksum, detail
  ) values (
    p_workspace_id, 'import', v_member_id, v_agent_ids, v_agent_names, v_skills_written, p_checksum,
    jsonb_build_object(
      'rule', v_rule,
      'agents_written', cardinality(v_agent_ids),
      'skills_written', v_skills_written,
      'disabled', v_disabled,
      'agents', v_outcomes
    )
  ) returning id into v_event_id;
  return v_event_id;
end;
$$;
comment on function public.import_agent_pack(uuid, text, jsonb) is 'Imports an agent pack plan in one transaction (AGO-194). Owners with a signed-in session only; agents land strict, Tier 3+ is never granted, and one pack_events row records the import.';
revoke all on function public.import_agent_pack(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.import_agent_pack(uuid, text, jsonb) to authenticated;
