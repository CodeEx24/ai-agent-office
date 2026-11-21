-- AGO-117: the Manager splits a goal into tasks. The Manager proposes tasks with briefs, suggested owners and
-- dependencies; they land in the Inbox (no assignee) and a person decides who starts them.
-- Rollback: supabase/rollbacks/20261121020001_ago_117_goal_task_proposals.down.sql
--
-- Design (docs/tickets/AGO-117.md):
--   * public.tasks.suggested_agent_id: advice only. The board puts a task in Inbox when agent_id is null, so a proposal
--     never sets agent_id. Composite FK to agents, on delete set null.
--   * public.tasks.depends_on_task_ids: the proposed tasks this one waits for (only tasks of the same proposal call, and
--     only EARLIER ones, so there can be no cycle). Stored and validated; nothing schedules on it yet.
--   * public.create_goal_tasks: the only writer of both columns. SECURITY DEFINER, service_role only. It never trusts
--     the worker: the Manager is read from the run, the goal must be the one the run's task was created for, every
--     suggested agent must be a live agent of the workspace, and the human requester is copied from the run's task.
--     It has no path that inserts into public.agents: the Manager cannot create or hire agents.

alter table public.tasks
  add column suggested_agent_id uuid,
  add column depends_on_task_ids uuid[] not null default '{}';

alter table public.tasks
  add constraint tasks_suggested_agent_fk foreign key (workspace_id, suggested_agent_id)
    references public.agents (workspace_id, id) on delete set null (suggested_agent_id),
  add constraint tasks_depends_on_max check (cardinality(depends_on_task_ids) <= 11),
  add constraint tasks_depends_on_not_self check (not (id = any (depends_on_task_ids))),
  add constraint tasks_depends_on_no_null check (array_position(depends_on_task_ids, null::uuid) is null);
create index tasks_suggested_agent_idx on public.tasks (workspace_id, suggested_agent_id) where suggested_agent_id is not null;

comment on column public.tasks.suggested_agent_id is 'The agent the Manager suggests for this task (AGO-117). Advice only: agent_id stays null until a person assigns. Set only by create_goal_tasks.';
comment on column public.tasks.depends_on_task_ids is 'Earlier tasks of the same proposal this task waits for (AGO-117). Set only by create_goal_tasks.';

revoke insert (suggested_agent_id, depends_on_task_ids), update (suggested_agent_id, depends_on_task_ids)
  on public.tasks from anon, authenticated;

-- p_items: a JSON array of 1..12 objects { ref, title, brief, suggested_agent_id?, depends_on: [ref] }.
-- A ref is a label (a-z, 0-9, _ and -, up to 40 characters), unique in the call. depends_on may only name refs listed
-- BEFORE the item. Returns the new task ids in item order. All or nothing.
-- Errors: 22023 bad input or a rule broken, P0002 run, goal or agent not found, 42501 the run's agent is not an active Manager.
create function public.create_goal_tasks(
  p_workspace_id uuid,
  p_run_id uuid,
  p_goal_id uuid,
  p_items jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_plan public.tasks%rowtype;
  v_count integer;
  v_existing integer;
  v_refs text[] := '{}';
  v_ids uuid[] := '{}';
  v_item jsonb;
  v_idx integer := 0;
  v_ref text;
  v_dep text;
  v_dep_pos integer;
  v_deps uuid[];
  v_suggested uuid;
  v_title text;
  v_brief text;
begin
  if p_workspace_id is null or p_run_id is null or p_goal_id is null or p_items is null
     or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'a task proposal needs a workspace, run, goal and an item list' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_items);
  if v_count not between 1 and 12 then
    raise exception 'a proposal holds 1 to 12 tasks' using errcode = '22023';
  end if;

  select * into v_run from public.runs where workspace_id = p_workspace_id and id = p_run_id;
  if not found or v_run.task_id is null then
    raise exception 'run not found or has no task' using errcode = 'P0002';
  end if;
  -- The caller must be an active Manager (the role the goal inbox uses to pick the Manager).
  if not exists (
    select 1 from public.agents a
     where a.workspace_id = p_workspace_id and a.id = v_run.agent_id
       and a.archived_at is null and lower(btrim(a.role)) = 'manager'
  ) then
    raise exception 'only an active Manager can propose tasks' using errcode = '42501';
  end if;
  -- FOR UPDATE: two proposals for one plan task are serialized, so the per-goal cap below cannot be raced.
  select * into v_plan from public.tasks where workspace_id = p_workspace_id and id = v_run.task_id for update;
  if not found or v_plan.agent_id is distinct from v_run.agent_id then
    raise exception 'the run does not belong to the task''s agent' using errcode = 'P0002';
  end if;
  -- Only the goal this run was asked to plan.
  if v_plan.goal_id is distinct from p_goal_id
     or not exists (select 1 from public.goals g where g.workspace_id = p_workspace_id and g.id = p_goal_id) then
    raise exception 'the run is not planning this goal' using errcode = 'P0002';
  end if;
  if v_plan.created_by is null then
    raise exception 'the plan task has no human requester' using errcode = '22023';
  end if;
  -- Tasks already made for this goal (the plan task itself carries goal_id too, so it is not counted).
  select count(*) into v_existing from public.tasks t
   where t.workspace_id = p_workspace_id and t.goal_id = p_goal_id and t.id <> v_plan.id;
  if v_existing + v_count > 24 then
    raise exception 'a goal can have at most 24 proposed tasks' using errcode = '22023';
  end if;

  -- Pass 1: shape and refs.
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'each task must be an object' using errcode = '22023';
    end if;
    v_ref := v_item ->> 'ref';
    if v_ref is null or v_ref !~ '^[a-z0-9_-]{1,40}$' or v_ref = any (v_refs) then
      raise exception 'each task needs a unique ref' using errcode = '22023';
    end if;
    v_refs := v_refs || v_ref;
    v_ids := v_ids || gen_random_uuid();
  end loop;

  -- Pass 2: validate and insert, in order, so a dependency can only point at an earlier task.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_idx := v_idx + 1;
    v_title := v_item ->> 'title';
    v_brief := coalesce(v_item ->> 'brief', '');
    if jsonb_typeof(v_item -> 'title') is distinct from 'string' or char_length(btrim(v_title)) not between 1 and 300 then
      raise exception 'bad task title' using errcode = '22023';
    end if;
    if jsonb_typeof(v_item -> 'brief') is distinct from 'string' or char_length(btrim(v_brief)) = 0
       or char_length(v_brief) > 4000 then
      raise exception 'each task needs a brief of 1 to 4000 characters' using errcode = '22023';
    end if;

    v_suggested := null;
    if v_item ? 'suggested_agent_id' and jsonb_typeof(v_item -> 'suggested_agent_id') <> 'null' then
      if jsonb_typeof(v_item -> 'suggested_agent_id') <> 'string'
         or (v_item ->> 'suggested_agent_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'bad suggested agent id' using errcode = '22023';
      end if;
      v_suggested := (v_item ->> 'suggested_agent_id')::uuid;
      -- An existing, non-archived agent of THIS workspace. Never created here; an unknown id fails the whole call.
      perform 1 from public.agents a
        where a.workspace_id = p_workspace_id and a.id = v_suggested and a.archived_at is null
        for share;
      if not found then
        raise exception 'unknown or archived agent' using errcode = 'P0002';
      end if;
    end if;

    v_deps := '{}';
    if v_item ? 'depends_on' then
      if jsonb_typeof(v_item -> 'depends_on') is distinct from 'array' then
        raise exception 'depends_on must be a list of refs' using errcode = '22023';
      end if;
      for v_dep in select jsonb_array_elements_text(v_item -> 'depends_on') loop
        v_dep_pos := array_position(v_refs, v_dep);
        if v_dep_pos is null or v_dep_pos >= v_idx then
          raise exception 'a dependency must name an earlier task of this proposal' using errcode = '22023';
        end if;
        if not (v_ids[v_dep_pos] = any (v_deps)) then
          v_deps := v_deps || v_ids[v_dep_pos];
        end if;
      end loop;
    end if;

    -- agent_id stays null: the task is in the Inbox. created_by is the human who set the goal (never from input).
    insert into public.tasks (id, workspace_id, title, description, agent_id, created_by, goal_id,
                              suggested_agent_id, depends_on_task_ids)
    values (v_ids[v_idx], p_workspace_id, btrim(v_title), v_brief, null, v_plan.created_by, p_goal_id,
            v_suggested, v_deps);
  end loop;
  return v_ids;
end;
$$;
comment on function public.create_goal_tasks(uuid, uuid, uuid, jsonb) is 'The Manager''s proposal: writes 1..12 Inbox tasks for a goal in one transaction (AGO-117). service_role only; never creates an agent.';
revoke all on function public.create_goal_tasks(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_goal_tasks(uuid, uuid, uuid, jsonb) to service_role;
