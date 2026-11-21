-- AGO-117: the Manager splits a goal into tasks (pgTAP).
--   create_goal_tasks is SECURITY DEFINER, search_path pinned, executable by service_role only; the new task columns are
--   not writable by anon or authenticated; a proposal makes Inbox tasks (agent_id null) with the goal, the human
--   requester copied from the plan task, the suggested owner and earlier dependencies; a run that is not an active
--   Manager, a goal the run was not asked to plan, an unknown, archived or foreign agent, a forward or unknown
--   dependency, a duplicate ref, 0 or 13 items and more than 24 tasks per goal are all refused; a refusal stores
--   nothing (all or nothing); no agent is ever created.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-117).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures. A: one member, the Manager (with a plan task for goal one and a run), a Writer (with a task for goal one and a
-- run), an archived agent and a second goal the Manager's run was NOT asked to plan. B: a stranger agent.
insert into auth.users (id, instance_id, aud, role, email) values
  ('11700000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago117-member@example.test');
insert into public.workspaces (id, name) values
  ('117aaaaa-0000-0000-0000-000000000001', 'AGO-117 A'),
  ('117bbbbb-0000-0000-0000-000000000001', 'AGO-117 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('117aaaaa-0000-0000-0000-0000000000a1', '117aaaaa-0000-0000-0000-000000000001', '11700000-0000-0000-0000-00000000000a', 'member');
insert into public.agents (id, workspace_id, name, role, archived_at) values
  ('117aaaaa-0000-0000-0000-000000000b01', '117aaaaa-0000-0000-0000-000000000001', 'manager', 'Manager', null),
  ('117aaaaa-0000-0000-0000-000000000b02', '117aaaaa-0000-0000-0000-000000000001', 'writer', 'Writer', null),
  ('117aaaaa-0000-0000-0000-000000000b03', '117aaaaa-0000-0000-0000-000000000001', 'retired', 'Writer', now()),
  ('117bbbbb-0000-0000-0000-000000000b01', '117bbbbb-0000-0000-0000-000000000001', 'stranger', 'Writer', null);
insert into public.goals (id, workspace_id, text, created_by) values
  ('117aaaaa-0000-0000-0000-0000000000c1', '117aaaaa-0000-0000-0000-000000000001', 'goal one', '117aaaaa-0000-0000-0000-0000000000a1'),
  ('117aaaaa-0000-0000-0000-0000000000c2', '117aaaaa-0000-0000-0000-000000000001', 'goal two', '117aaaaa-0000-0000-0000-0000000000a1');
insert into public.tasks (id, workspace_id, title, agent_id, created_by, goal_id) values
  ('117aaaaa-0000-0000-0000-0000000000d1', '117aaaaa-0000-0000-0000-000000000001', 'Plan goal: one',
   '117aaaaa-0000-0000-0000-000000000b01', '117aaaaa-0000-0000-0000-0000000000a1', '117aaaaa-0000-0000-0000-0000000000c1'),
  ('117aaaaa-0000-0000-0000-0000000000d2', '117aaaaa-0000-0000-0000-000000000001', 'Writer task',
   '117aaaaa-0000-0000-0000-000000000b02', '117aaaaa-0000-0000-0000-0000000000a1', '117aaaaa-0000-0000-0000-0000000000c1');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000d1', '117aaaaa-0000-0000-0000-000000000b01'),
  ('117aaaaa-0000-0000-0000-0000000000e2', '117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000d2', '117aaaaa-0000-0000-0000-000000000b02');

-- 1. Function shape and privileges.
select is(has_function_privilege('service_role', 'public.create_goal_tasks(uuid,uuid,uuid,jsonb)', 'EXECUTE'), true, 'service_role can execute create_goal_tasks');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, 'public.create_goal_tasks(uuid,uuid,uuid,jsonb)', 'EXECUTE')),
  0, 'anon and authenticated cannot execute it');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.create_goal_tasks(uuid,uuid,uuid,jsonb)'::regprocedure and a.grantee = 0),
  0, 'PUBLIC holds no execute');
select is((select prosecdef from pg_proc where oid = 'public.create_goal_tasks(uuid,uuid,uuid,jsonb)'::regprocedure), true, 'it is security definer');
select is(
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.create_goal_tasks(uuid,uuid,uuid,jsonb)'::regprocedure),
  'search_path=""', 'search_path is pinned to empty');
select is(
  (select count(*)::int from unnest(array['suggested_agent_id', 'depends_on_task_ids']) c, unnest(array['INSERT', 'UPDATE']) p
    where has_column_privilege('anon', 'public.tasks', c, p) or has_column_privilege('authenticated', 'public.tasks', c, p)),
  0, 'the new task columns are not writable by anon or authenticated');

-- 2. A proposal: Inbox tasks with briefs, the suggested owner, an earlier dependency, the human requester.
create temp table made (ids uuid[]);
insert into made select public.create_goal_tasks(
  '117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
  '[{"ref":"research","title":"Research the market","brief":"Find three competitors.","suggested_agent_id":"117aaaaa-0000-0000-0000-000000000b02","depends_on":[]},
    {"ref":"write","title":"Write the plan","brief":"Draft one page.","depends_on":["research"]}]'::jsonb);
select is((select cardinality(ids) from made), 2, 'two task ids come back');
select is(
  (select count(*)::int from public.tasks t, made m where t.id = any (m.ids) and t.agent_id is null and t.status = 'todo'
      and t.goal_id = '117aaaaa-0000-0000-0000-0000000000c1' and t.created_by = '117aaaaa-0000-0000-0000-0000000000a1'
      and t.description <> ''),
  2, 'both tasks are Inbox tasks (no assignee) with a brief, the goal and the human requester');
select is(
  (select t.suggested_agent_id from public.tasks t, made m where t.id = m.ids[1]),
  '117aaaaa-0000-0000-0000-000000000b02'::uuid, 'the suggested owner is stored');
select is(
  (select t.depends_on_task_ids from public.tasks t, made m where t.id = m.ids[2]),
  (select array[m.ids[1]] from made m), 'the dependency points at the earlier task');
select is((select count(*)::int from public.agents where workspace_id = '117aaaaa-0000-0000-0000-000000000001'), 3, 'no agent was created');

-- 3. Refusals. Each one stores nothing.
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e2', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b"}]'::jsonb)$$,
  '42501', 'only an active Manager can propose tasks', 'a run of a non-Manager agent is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c2',
     '[{"ref":"a","title":"t","brief":"b"}]'::jsonb)$$,
  'P0002', 'the run is not planning this goal', 'a goal the run was not asked to plan is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b","suggested_agent_id":"117aaaaa-0000-0000-0000-000000000b03"}]'::jsonb)$$,
  'P0002', 'unknown or archived agent', 'an archived agent cannot be suggested');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b","suggested_agent_id":"117bbbbb-0000-0000-0000-000000000b01"}]'::jsonb)$$,
  'P0002', 'unknown or archived agent', 'an agent of another workspace cannot be suggested');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b","suggested_agent_id":"99999999-9999-4999-8999-999999999999"}]'::jsonb)$$,
  'P0002', 'unknown or archived agent', 'an unknown agent id is refused, never created');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b","depends_on":["b"]},{"ref":"b","title":"t","brief":"b"}]'::jsonb)$$,
  '22023', 'a dependency must name an earlier task of this proposal', 'a forward dependency is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b","depends_on":["a"]}]'::jsonb)$$,
  '22023', 'a dependency must name an earlier task of this proposal', 'a self dependency is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"b"},{"ref":"a","title":"t","brief":"b"}]'::jsonb)$$,
  '22023', 'each task needs a unique ref', 'a duplicate ref is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"a","title":"t","brief":"   "}]'::jsonb)$$,
  '22023', 'each task needs a brief of 1 to 4000 characters', 'a blank brief is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1', '[]'::jsonb)$$,
  '22023', 'a proposal holds 1 to 12 tasks', 'an empty proposal is refused');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     (select jsonb_agg(jsonb_build_object('ref', 'r' || g, 'title', 't', 'brief', 'b')) from generate_series(1, 13) g))$$,
  '22023', 'a proposal holds 1 to 12 tasks', '13 tasks in one call are refused');

-- All or nothing: the first item is fine, the second names an archived agent; nothing is stored.
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     '[{"ref":"ok","title":"Fine","brief":"b"},{"ref":"bad","title":"t","brief":"b","suggested_agent_id":"117aaaaa-0000-0000-0000-000000000b03"}]'::jsonb)$$,
  'P0002', 'unknown or archived agent', 'a bad second item fails the call');
select is(
  (select count(*)::int from public.tasks where workspace_id = '117aaaaa-0000-0000-0000-000000000001' and title = 'Fine'),
  0, 'the first item was not stored (all or nothing)');

-- The cap of 24 per goal counts every task with the goal id except the plan task: the Writer's task and 2 proposals so far.
select lives_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     (select jsonb_agg(jsonb_build_object('ref', 'r' || g, 'title', 't', 'brief', 'b')) from generate_series(1, 12) g))$$,
  'a second proposal of 12 fits under the cap');
select throws_ok(
  $$select public.create_goal_tasks('117aaaaa-0000-0000-0000-000000000001', '117aaaaa-0000-0000-0000-0000000000e1', '117aaaaa-0000-0000-0000-0000000000c1',
     (select jsonb_agg(jsonb_build_object('ref', 'r' || g, 'title', 't', 'brief', 'b')) from generate_series(1, 12) g))$$,
  '22023', 'a goal can have at most 24 proposed tasks', 'a goal cannot get more than 24 proposed tasks');

select is((select count(*)::int from public.agents where workspace_id = '117aaaaa-0000-0000-0000-000000000001'), 3, 'still no agent was created');

select * from finish();
rollback;
