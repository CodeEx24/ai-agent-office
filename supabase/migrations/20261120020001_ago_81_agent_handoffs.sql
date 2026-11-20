-- AGO-81: agent-to-agent handoffs. A handoff IS a task row: the sending agent creates a task for another agent and
-- the receiver gets the intersection of both agents' permissions, acting for the human who started the work.
-- Rollback: supabase/rollbacks/20261120020001_ago_81_agent_handoffs.down.sql
--
-- Design (docs/tickets/AGO-81.md, D5):
--   * public.tasks gets handoff columns: parent_task_id, handoff_from_agent_id, requester_member_id, handoff_depth,
--     handoff_path (agent ids, first sender to receiver), handoff_grants (the narrowed set stored at handoff time)
--     and handoff_run_id (the receiver's run that accepted it). All are NULL on an ordinary task.
--   * None of them is in any column grant for anon or authenticated: an agent token or a person cannot write
--     requester_member_id or handoff_grants. The only writers are the two SECURITY DEFINER functions below, which
--     only service_role (the worker) can execute (same convention as the AGO-160 claim functions).
--   * RLS is unchanged: tasks stays scoped by workspace_id. Every foreign key is composite (workspace_id, id), so a
--     handoff can never point at another workspace's task, agent, member or run.
--   * CHECK constraints are the backstop for the worker rules: depth 1..3 (MAX_HANDOFF_DEPTH), a path of depth + 1
--     agents ending at the receiver, no repeated agent (no cycle, no self handoff), and a requester on every handoff.

alter table public.tasks
  add column parent_task_id uuid,
  add column handoff_from_agent_id uuid,
  add column requester_member_id uuid,
  add column handoff_depth smallint,
  add column handoff_path uuid[],
  add column handoff_grants jsonb,
  add column handoff_run_id uuid;

alter table public.tasks
  -- A task is a handoff exactly when handoff_from_agent_id is set; then every other handoff column is set too
  -- (handoff_run_id and parent_task_id may stay null: not accepted yet, parent deleted).
  add constraint tasks_handoff_all_or_none check (
    (handoff_from_agent_id is null
       and parent_task_id is null and requester_member_id is null and handoff_depth is null
       and handoff_path is null and handoff_grants is null and handoff_run_id is null)
    or
    (handoff_from_agent_id is not null
       and requester_member_id is not null and handoff_depth is not null
       and handoff_path is not null and handoff_grants is not null)
  ),
  -- Same limit as MAX_HANDOFF_DEPTH in packages/shared/src/handoff/handoff-schemas.ts.
  add constraint tasks_handoff_depth_range check (handoff_depth is null or handoff_depth between 1 and 3),
  -- The path holds every agent from the first sender to the receiver: depth + 1 agents, the sender is second to last,
  -- the receiver (the assignee) is last, and nobody appears twice.
  add constraint tasks_handoff_path_shape check (
    handoff_path is null
    or (cardinality(handoff_path) = handoff_depth + 1
        and array_position(handoff_path, null::uuid) is null
        and handoff_path[cardinality(handoff_path) - 1] = handoff_from_agent_id
        and handoff_path[cardinality(handoff_path)] = agent_id
        -- No agent twice. The depth range caps the path at 4 agents, so pairwise checks cover it (a missing
        -- element is null, and a null comparison passes). No helper function: one would be executable by anon.
        and handoff_path[1] <> handoff_path[2] and handoff_path[1] <> handoff_path[3]
        and handoff_path[1] <> handoff_path[4] and handoff_path[2] <> handoff_path[3]
        and handoff_path[2] <> handoff_path[4] and handoff_path[3] <> handoff_path[4])
  ),
  add constraint tasks_handoff_grants_shape check (
    handoff_grants is null
    or (jsonb_typeof(handoff_grants) = 'object'
        and jsonb_typeof(handoff_grants -> 'capabilities') = 'array'
        and jsonb_typeof(handoff_grants -> 'budgetCents') = 'number'
        and jsonb_typeof(handoff_grants -> 'dataScope') = 'array')
  ),
  add constraint tasks_handoff_parent_fk foreign key (workspace_id, parent_task_id)
    references public.tasks (workspace_id, id) on delete set null (parent_task_id),
  add constraint tasks_handoff_from_agent_fk foreign key (workspace_id, handoff_from_agent_id)
    references public.agents (workspace_id, id) on delete no action,
  add constraint tasks_handoff_requester_fk foreign key (workspace_id, requester_member_id)
    references public.members (workspace_id, id) on delete no action,
  add constraint tasks_handoff_run_fk foreign key (workspace_id, handoff_run_id)
    references public.runs (workspace_id, id) on delete no action;
create index tasks_workspace_parent_idx on public.tasks (workspace_id, parent_task_id);
create unique index tasks_handoff_run_unique on public.tasks (workspace_id, handoff_run_id) where handoff_run_id is not null;
-- Foreign key lookups (deleting an agent or a member checks these columns).
create index tasks_handoff_from_agent_idx on public.tasks (workspace_id, handoff_from_agent_id) where handoff_from_agent_id is not null;
create index tasks_requester_member_idx on public.tasks (workspace_id, requester_member_id) where requester_member_id is not null;

comment on column public.tasks.parent_task_id is 'The task the sending agent was working on when it handed off (AGO-81). Set only by create_handoff_task.';
comment on column public.tasks.handoff_from_agent_id is 'The agent that handed this task off (AGO-81). Null on an ordinary task. Set only by create_handoff_task.';
comment on column public.tasks.requester_member_id is 'The human member the whole handoff chain acts for (AGO-81). Copied from the root task; no agent or person can write it.';
comment on column public.tasks.handoff_depth is 'Hops from the human request: 1..3 (AGO-81).';
comment on column public.tasks.handoff_path is 'Agent ids from the first sender to the receiver (AGO-81). No repeats.';
comment on column public.tasks.handoff_grants is 'The receiver''s effective permissions: the intersection computed at handoff time (AGO-81). Never wider than the sender held. No agent or person can write it.';
comment on column public.tasks.handoff_run_id is 'The receiver''s run that accepted the handoff (AGO-81). One run per handoff. Set only by accept_handoff_task.';

-- The grants of AGO-107 and AGO-113 name their columns, so the new ones are in no grant. Say it explicitly anyway.
revoke insert (parent_task_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants, handoff_run_id),
       update (parent_task_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants, handoff_run_id)
  on public.tasks from anon, authenticated;

-- Creates the handoff task. SECURITY DEFINER on purpose: it is the only writer of the handoff columns, and the
-- worker is not trusted to send a well formed row (the table constraints above are the second line).
-- What it never trusts from the caller: the sender is the run's agent (read from the run), the requester and the path
-- are derived from the sender's own task and only compared with what was passed, and the narrowed set must be a subset
-- of what the sender holds right now.
-- p_path is the chain INCLUDING the receiver; p_depth is the number of agents before the receiver.
-- Errors: 22023 bad input or wider than the sender, P0002 run, task or agent not found.
create function public.create_handoff_task(
  p_workspace_id uuid,
  p_run_id uuid,
  p_task_id uuid,
  p_to_agent_id uuid,
  p_title text,
  p_description text,
  p_requester_member_id uuid,
  p_path uuid[],
  p_depth integer,
  p_grants jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_parent public.tasks%rowtype;
  v_requester uuid;
  v_chain uuid[];
  v_capability jsonb;
  v_budget bigint;
  v_stored integer;
  v_effective bigint;
  v_used bigint;
  v_limit bigint;
  v_parent_spent bigint;
begin
  if p_workspace_id is null or p_run_id is null or p_task_id is null or p_to_agent_id is null
     or p_requester_member_id is null or p_path is null or p_depth is null or p_grants is null then
    raise exception 'a handoff needs every field' using errcode = '22023';
  end if;
  if p_title is null or char_length(p_title) not between 1 and 300 or char_length(coalesce(p_description, '')) > 10000 then
    raise exception 'bad handoff title or description' using errcode = '22023';
  end if;
  if jsonb_typeof(p_grants -> 'capabilities') is distinct from 'array'
     or jsonb_typeof(p_grants -> 'budgetCents') is distinct from 'number'
     or jsonb_typeof(p_grants -> 'dataScope') is distinct from 'array' then
    raise exception 'bad handoff grants' using errcode = '22023';
  end if;
  -- No stored data scope exists for an agent yet, so nothing can be passed on: a non-empty scope is refused.
  if jsonb_array_length(p_grants -> 'dataScope') <> 0 then
    raise exception 'the handoff is wider than the sender (data scope)' using errcode = '22023';
  end if;
  -- Whole cents only (a fraction or an exponent would not cast).
  if (p_grants ->> 'budgetCents') !~ '^[0-9]{1,12}$' then
    raise exception 'bad handoff budget' using errcode = '22023';
  end if;
  v_budget := (p_grants ->> 'budgetCents')::bigint;

  select * into v_run from public.runs where workspace_id = p_workspace_id and id = p_run_id;
  if not found or v_run.task_id is null then
    raise exception 'run not found or has no task' using errcode = 'P0002';
  end if;
  -- FOR SHARE: the parent row cannot change under this call (its grants are read below).
  select * into v_parent from public.tasks where workspace_id = p_workspace_id and id = v_run.task_id for share;
  -- The run's agent is the task's assignee: a run on someone else's task is not a sender we can read a chain from.
  if v_parent.agent_id is distinct from v_run.agent_id then
    raise exception 'the run does not belong to the task''s agent' using errcode = 'P0002';
  end if;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  -- The chain comes from the sender's own task: a handoff task passes its requester and path on; a human task
  -- (created_by is a member) starts a chain at the run's agent.
  if v_parent.handoff_from_agent_id is not null then
    v_requester := v_parent.requester_member_id;
    v_chain := v_parent.handoff_path;
  else
    v_requester := v_parent.created_by;
    v_chain := array[v_run.agent_id];
  end if;
  if v_requester is null then
    raise exception 'the task has no human requester' using errcode = '22023';
  end if;
  if v_chain[cardinality(v_chain)] <> v_run.agent_id then
    raise exception 'the chain does not end at the sender' using errcode = '22023';
  end if;
  if p_requester_member_id <> v_requester then
    raise exception 'requester does not match the chain' using errcode = '22023';
  end if;
  if p_path <> (v_chain || p_to_agent_id) or p_depth <> cardinality(v_chain) then
    raise exception 'path does not match the chain' using errcode = '22023';
  end if;
  -- Depth, cycle and self handoff are also table constraints; refusing here gives a clear error.
  if p_depth > 3 then
    raise exception 'handoff chain is too deep' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_path) as x) <> cardinality(p_path) then
    raise exception 'handoff cycle or self handoff' using errcode = '22023';
  end if;

  if not exists (select 1 from public.agents where workspace_id = p_workspace_id and id = v_run.agent_id and archived_at is null)
     or not exists (select 1 from public.agents where workspace_id = p_workspace_id and id = p_to_agent_id and archived_at is null) then
    raise exception 'sender or receiver is not an active agent' using errcode = 'P0002';
  end if;

  -- The requester must still be an active member of the workspace.
  if not exists (
    select 1 from public.members m
     where m.workspace_id = p_workspace_id and m.id = v_requester and m.removed_at is null
  ) then
    raise exception 'the requester is no longer an active member' using errcode = '22023';
  end if;

  -- Budget: at most what the sender still has today (its effective daily budget, as effectiveDailyBudgetCents in
  -- packages/shared: a missing value is 500, above 5000 is pulled to 5000, minus today's UTC usage) and, on hop 2 or
  -- later, at most the parent handoff's own budget.
  select a.daily_budget_cents into v_stored
    from public.agents a where a.workspace_id = p_workspace_id and a.id = v_run.agent_id;
  v_effective := case when v_stored is null or v_stored < 1 then 500 else least(v_stored, 5000) end;
  select coalesce(sum(b.cost_used_cents), 0) into v_used
    from public.budgets_usage b
   where b.workspace_id = p_workspace_id and b.agent_id = v_run.agent_id
     and b.period_start = (now() at time zone 'utc')::date;
  v_limit := greatest(0, v_effective - v_used);
  if v_parent.handoff_from_agent_id is not null then
    -- The parent's REMAINING budget: its budget minus what the runs on its task already spent (budget.usage events;
    -- a cost that is not 1..12 digits counts as 0, and the cast sits inside the CASE so it never runs on a huge value).
    select coalesce(sum(case when (e.payload ->> 'cost_cents') ~ '^[0-9]{1,12}$'
                             then (e.payload ->> 'cost_cents')::bigint else 0 end), 0)
      into v_parent_spent
      from public.run_events e
      join public.runs r on r.workspace_id = e.workspace_id and r.id = e.run_id
     where e.workspace_id = p_workspace_id and r.task_id = v_parent.id and e.type = 'budget.usage';
    v_limit := least(v_limit, greatest(0, (v_parent.handoff_grants ->> 'budgetCents')::bigint - v_parent_spent));
  end if;
  if v_budget > v_limit then
    raise exception 'the handoff is wider than the sender (budget)' using errcode = '22023';
  end if;

  -- Never wider than the sender: every capability in the narrowed set is one the sender holds now, enabled in the
  -- catalog, and the narrowed tier is not lower than the sender's (a bigger number is a stricter tier); the narrowed
  -- mode is approval whenever the sender's is. On hop 2 or later the sender is itself running inside a handoff, so
  -- the set must also fit inside the PARENT handoff's narrowed set (same tier and mode rules): B cannot pass on to C
  -- what A did not pass on to B.
  for v_capability in select * from jsonb_array_elements(p_grants -> 'capabilities') loop
    if jsonb_typeof(v_capability) is distinct from 'object'
       or coalesce((v_capability ->> 'tier') !~ '^[0-4]$', true)
       or coalesce((v_capability ->> 'mode') not in ('automatic', 'approval'), true) then
      raise exception 'bad handoff grants' using errcode = '22023';
    end if;
    if v_parent.handoff_from_agent_id is not null and not exists (
      select 1 from jsonb_array_elements(v_parent.handoff_grants -> 'capabilities') pc
       where pc ->> 'capabilityKey' = v_capability ->> 'capabilityKey'
         and (pc ->> 'tier')::int <= (v_capability ->> 'tier')::int
         and (pc ->> 'mode' = 'automatic' or v_capability ->> 'mode' = 'approval')
    ) then
      raise exception 'the handoff is wider than the sender (parent handoff)' using errcode = '22023';
    end if;
    if not exists (
      select 1
        from public.agent_capabilities ac
        join public.capabilities c on c.workspace_id = ac.workspace_id and c.key = ac.capability
       where ac.workspace_id = p_workspace_id
         and ac.agent_id = v_run.agent_id
         and ac.capability = v_capability ->> 'capabilityKey'
         and c.enabled
         and greatest(ac.tier, c.tier) <= (v_capability ->> 'tier')::int
         and (ac.mode = 'automatic' or v_capability ->> 'mode' = 'approval')
    ) then
      raise exception 'the handoff is wider than the sender' using errcode = '22023';
    end if;
  end loop;

  insert into public.tasks (
    id, workspace_id, title, description, agent_id, created_by,
    parent_task_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants
  )
  values (
    p_task_id, p_workspace_id, p_title, coalesce(p_description, ''), p_to_agent_id, null,
    v_parent.id, v_run.agent_id, v_requester, p_depth, p_path, p_grants
  );
  return p_task_id;
end;
$$;
comment on function public.create_handoff_task(uuid, uuid, uuid, uuid, text, text, uuid, uuid[], integer, jsonb)
  is 'Worker only (service_role). Creates a handoff task; the chain and requester come from the sender''s own task, never from the caller (AGO-81).';
revoke all on function public.create_handoff_task(uuid, uuid, uuid, uuid, text, text, uuid, uuid[], integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_handoff_task(uuid, uuid, uuid, uuid, text, text, uuid, uuid[], integer, jsonb)
  to service_role;

-- The receiver's run takes the handoff. Only a run of the assigned agent can; a second accept returns false.
create function public.accept_handoff_task(p_workspace_id uuid, p_task_id uuid, p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.tasks t
     set handoff_run_id = p_run_id
   where t.workspace_id = p_workspace_id
     and t.id = p_task_id
     and t.handoff_from_agent_id is not null
     and t.handoff_run_id is null
     and exists (
       select 1 from public.runs r
        where r.workspace_id = p_workspace_id and r.id = p_run_id and r.agent_id = t.agent_id
     );
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;
comment on function public.accept_handoff_task(uuid, uuid, uuid) is 'Worker only (service_role). Links the receiver''s run to its handoff task once (AGO-81).';
revoke all on function public.accept_handoff_task(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_handoff_task(uuid, uuid, uuid) to service_role;
