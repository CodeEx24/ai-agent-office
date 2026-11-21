-- AGO-81: agent-to-agent handoffs (pgTAP).
--   privileges: create_handoff_task and accept_handoff_task are SECURITY DEFINER, search_path pinned, executable by
--   service_role only; the handoff columns of tasks are in no grant for anon or authenticated (requester_member_id and
--   handoff_grants cannot be written by an agent or a person); tasks stays workspace scoped (RLS);
--   a handoff is never wider than the sender (capability, tier, mode); the requester and the path come from the
--   sender's own task, a forged one is refused; depth over 3, a cycle and a self handoff are refused by the function
--   AND by table constraints; another workspace's agent is refused; accept is once, by the receiver's run only.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-81).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures. Workspace A: a human member M, agents A (sender), B, C, D, E and an archived agent X. Workspace B: an owner
-- and one agent.
insert into auth.users (id, instance_id, aud, role, email) values
  ('81000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago81-m@example.test'),
  ('81000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago81-b@example.test');
insert into public.workspaces (id, name) values
  ('81000000-0000-4000-8000-0000000000a1', 'AGO-81 A'),
  ('81000000-0000-4000-8000-0000000000b1', 'AGO-81 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('81000000-0000-4000-8000-0000000001a1', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-00000000000a', 'member'),
  ('81000000-0000-4000-8000-0000000001b1', '81000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name, archived_at) values
  ('81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000000a1', 'A', null),
  ('81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000000a1', 'B', null),
  ('81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000000a1', 'C', null),
  ('81000000-0000-4000-8000-0000000002a4', '81000000-0000-4000-8000-0000000000a1', 'D', null),
  ('81000000-0000-4000-8000-0000000002a5', '81000000-0000-4000-8000-0000000000a1', 'E', null),
  ('81000000-0000-4000-8000-0000000002a6', '81000000-0000-4000-8000-0000000000a1', 'X-archived', now()),
  ('81000000-0000-4000-8000-0000000002b1', '81000000-0000-4000-8000-0000000000b1', 'other', null);
-- Catalog: vault.read tier 0, tasks.manage tier 1, web.search tier 1.
insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled) values
  ('81000000-0000-4000-8000-0000000000a1', 'vault.read', 'Read vault', 0, 'workspace', 'automatic', true),
  ('81000000-0000-4000-8000-0000000000a1', 'tasks.manage', 'Manage tasks', 1, 'workspace', 'automatic', true),
  ('81000000-0000-4000-8000-0000000000a1', 'web.search', 'Search the web', 1, 'external', 'automatic', true)
on conflict (workspace_id, key) do update set tier = excluded.tier, enabled = true;
-- The sender A holds vault.read (automatic) and web.search (approval). It does NOT hold tasks.manage. B holds all three.
insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode) values
  ('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000002a1', 'vault.read', 0, 'automatic'),
  ('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000002a1', 'web.search', 1, 'approval'),
  ('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000002a2', 'vault.read', 0, 'automatic'),
  ('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000002a2', 'tasks.manage', 1, 'automatic'),
  ('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000002a2', 'web.search', 1, 'approval');
-- The root task T0 was created by the human member M and assigned to A; A's run RA works on it.
insert into public.tasks (id, workspace_id, title, agent_id, created_by) values
  ('81000000-0000-4000-8000-0000000006a0', '81000000-0000-4000-8000-0000000000a1', 'root task', '81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000001a1');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a0', '81000000-0000-4000-8000-0000000002a1');

-- 1. Functions: SECURITY DEFINER, search_path pinned, service_role only.
select has_function('public', 'create_handoff_task', array['uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'uuid', 'uuid[]', 'integer', 'jsonb'], 'create_handoff_task exists');
select has_function('public', 'accept_handoff_task', array['uuid', 'uuid', 'uuid'], 'accept_handoff_task exists');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_handoff_task', 'accept_handoff_task')
      and p.prosecdef
      and array_to_string(p.proconfig, ',') = 'search_path=""'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)),
  2, 'both functions are SECURITY DEFINER, search_path pinned, executable by service_role only (not PUBLIC, anon, authenticated)');

-- 2. The handoff columns are in no insert or update grant for anon or authenticated.
select is(
  (select count(*)::int
     from unnest(array['parent_task_id', 'handoff_from_agent_id', 'requester_member_id', 'handoff_depth', 'handoff_path', 'handoff_grants', 'handoff_run_id']) col,
          unnest(array['anon', 'authenticated']) r,
          unnest(array['INSERT', 'UPDATE']) p
    where has_column_privilege(r, 'public.tasks', col, p)),
  0, 'no handoff column is writable by anon or authenticated');
select is((select relrowsecurity from pg_class where oid = 'public.tasks'::regclass), true, 'tasks still has RLS');

-- 3. The happy path, as service_role: A (task T0, run RA) hands off to B. The narrowed set is a subset of what A holds.
create temp table ctx (k text primary key, v uuid);
grant all on ctx to service_role, authenticated;
set local role service_role;
insert into ctx select 'h1', public.create_handoff_task(
  '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006a1',
  '81000000-0000-4000-8000-0000000002a2', 'Summarise', 'notes', '81000000-0000-4000-8000-0000000001a1',
  array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
  '{"capabilities":[{"capabilityKey":"vault.read","tier":0,"mode":"automatic"},{"capabilityKey":"web.search","tier":1,"mode":"approval"}],"budgetCents":100,"dataScope":[]}'::jsonb);
reset role;
select is((select v from ctx where k = 'h1'), '81000000-0000-4000-8000-0000000006a1'::uuid, 'a handoff returns the new task id');
select results_eq(
  $$ select agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, parent_task_id, created_by, handoff_path
       from public.tasks where id = '81000000-0000-4000-8000-0000000006a1' $$,
  $$ values ('81000000-0000-4000-8000-0000000002a2'::uuid, '81000000-0000-4000-8000-0000000002a1'::uuid,
             '81000000-0000-4000-8000-0000000001a1'::uuid, 1::smallint, '81000000-0000-4000-8000-0000000006a0'::uuid, null::uuid,
             array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[]) $$,
  'the task is for B, the requester is the human who started the root task, the chain is [A, B], and no agent is its creator');

-- 4. Never wider than the sender. Each of these is refused with 22023 and writes nothing.
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c1',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"tasks.manage","tier":1,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a capability the sender does not hold (tasks.manage) is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c2',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"web.search","tier":0,"mode":"approval"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a lower tier than the sender holds is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c3',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"web.search","tier":1,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'automatic mode where the sender needs approval is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c4',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"made.up","tier":0,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a capability that is in no catalog is refused');

-- 5. The requester and the chain come from the sender's own task; a forged one is refused.
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c5',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001b1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a requester that is not the one on the chain is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c6',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a path that does not start with the sender is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c7',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 2,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a depth that does not match the chain is refused');
-- A task nobody human created has no requester: an agent cannot start a chain from it.
reset role;
insert into public.tasks (id, workspace_id, title, agent_id) values
  ('81000000-0000-4000-8000-0000000006a9', '81000000-0000-4000-8000-0000000000a1', 'orphan', '81000000-0000-4000-8000-0000000002a1');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('81000000-0000-4000-8000-0000000007a9', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a9', '81000000-0000-4000-8000-0000000002a1');
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a9', '81000000-0000-4000-8000-0000000006c8',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a task with no human requester cannot start a handoff chain');

-- 6. Receivers: another workspace's agent and an archived agent are refused; a run of another workspace cannot be the sender.
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006c9',
       '81000000-0000-4000-8000-0000000002b1', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002b1']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  'P0002', null, 'an agent of another workspace cannot receive a handoff');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006d1',
       '81000000-0000-4000-8000-0000000002a6', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a6']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  'P0002', null, 'an archived agent cannot receive a handoff');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006d2',
       '81000000-0000-4000-8000-0000000002b1', 't', '', '81000000-0000-4000-8000-0000000001b1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002b1']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  'P0002', null, 'a run of another workspace cannot be used as the sender (the workspace is part of the key)');
select is((select count(*)::int from public.tasks where id::text like '81000000-0000-4000-8000-0000000006c%' or id::text like '81000000-0000-4000-8000-0000000006d%'),
  0, 'every refused handoff wrote nothing');

-- 7. Accept: only a run of the assigned agent, once.
reset role;
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('81000000-0000-4000-8000-0000000007b1', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000002a2'),
  ('81000000-0000-4000-8000-0000000007b2', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000002a3');
set local role service_role;
select is(public.accept_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000007b2'),
  false, 'a run of another agent cannot accept the handoff');
select is(public.accept_handoff_task('81000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000007b1'),
  false, 'accept is scoped by workspace');
select is(public.accept_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000007b1'),
  true, 'the receiver''s run accepts the handoff');
select is(public.accept_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000007b1'),
  false, 'a second accept returns false');
select is(public.accept_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a0', '81000000-0000-4000-8000-0000000007a1'),
  false, 'an ordinary task is not a handoff and cannot be accepted');

-- 8. Chains: B -> C -> D is depth 2 and 3 and keeps the requester; D -> E would be depth 4 and is refused; a cycle
--    (back to A) and a self handoff are refused.
insert into ctx select 'h2', public.create_handoff_task(
  '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007b1', '81000000-0000-4000-8000-0000000006a2',
  '81000000-0000-4000-8000-0000000002a3', 'part 2', '', '81000000-0000-4000-8000-0000000001a1',
  array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3']::uuid[], 2,
  '{"capabilities":[],"budgetCents":50,"dataScope":[]}'::jsonb);
reset role;
select results_eq(
  $$ select handoff_depth, requester_member_id, cardinality(handoff_path) from public.tasks where id = '81000000-0000-4000-8000-0000000006a2' $$,
  $$ values (2::smallint, '81000000-0000-4000-8000-0000000001a1'::uuid, 3) $$,
  'the second hop is depth 2 and keeps the human requester');
-- The receiver of hop 2 (C) has a run on it; C hands to D (depth 3).
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('81000000-0000-4000-8000-0000000007d1', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a2', '81000000-0000-4000-8000-0000000002a3');
set local role service_role;
insert into ctx select 'h3', public.create_handoff_task(
  '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007d1', '81000000-0000-4000-8000-0000000006a3',
  '81000000-0000-4000-8000-0000000002a4', 'part 3', '', '81000000-0000-4000-8000-0000000001a1',
  array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a4']::uuid[], 3,
  '{"capabilities":[],"budgetCents":20,"dataScope":[]}'::jsonb);
reset role;
select is((select handoff_depth from public.tasks where id = '81000000-0000-4000-8000-0000000006a3'), 3::smallint, 'the third hop is depth 3');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('81000000-0000-4000-8000-0000000007e1', '81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a3', '81000000-0000-4000-8000-0000000002a4');
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007e1', '81000000-0000-4000-8000-0000000006a4',
       '81000000-0000-4000-8000-0000000002a5', 'too deep', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a4', '81000000-0000-4000-8000-0000000002a5']::uuid[], 4,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a fourth hop (depth 4) is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007d1', '81000000-0000-4000-8000-0000000006a5',
       '81000000-0000-4000-8000-0000000002a1', 'cycle', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a1']::uuid[], 3,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a handoff back to an agent already in the chain (a cycle) is refused');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007d1', '81000000-0000-4000-8000-0000000006a6',
       '81000000-0000-4000-8000-0000000002a3', 'self', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a3']::uuid[], 3,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a handoff to yourself is refused');

-- 9. The table constraints are a second line: a row that skips the function is still refused.
reset role;
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants)
     values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000002a5', '81000000-0000-4000-8000-0000000002a4',
             '81000000-0000-4000-8000-0000000001a1', 4,
             array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a3', '81000000-0000-4000-8000-0000000002a4', '81000000-0000-4000-8000-0000000002a5']::uuid[],
             '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '23514', null, 'the table refuses depth 4');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants)
     values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2',
             '81000000-0000-4000-8000-0000000001a1', 2,
             array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a1']::uuid[],
             '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '23514', null, 'the table refuses a cycle');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants)
     values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a2',
             '81000000-0000-4000-8000-0000000001a1', 1,
             array['81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a2']::uuid[],
             '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '23514', null, 'the table refuses a self handoff');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, handoff_from_agent_id, handoff_depth, handoff_path, handoff_grants)
     values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000002a1', 1,
             array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[],
             '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '23514', null, 'the table refuses a handoff with no requester');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, requester_member_id)
     values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000002a2', '81000000-0000-4000-8000-0000000001a1') $$,
  '23514', null, 'an ordinary task cannot carry a requester on its own');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants)
     values ('81000000-0000-4000-8000-0000000000b1', 'x', '81000000-0000-4000-8000-0000000002b1', '81000000-0000-4000-8000-0000000002a1',
             '81000000-0000-4000-8000-0000000001b1', 1,
             array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002b1']::uuid[],
             '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '23503', null, 'a handoff cannot name a sender from another workspace (composite foreign key)');

-- 10. An agent token or a person cannot write the handoff columns or call the functions.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-00000000000a","role":"authenticated","agent_id":"81000000-0000-4000-8000-0000000002a1"}', true);
select throws_ok(
  $$ update public.tasks set requester_member_id = '81000000-0000-4000-8000-0000000001a1' where id = '81000000-0000-4000-8000-0000000006a0' $$,
  '42501', null, 'an agent token cannot write requester_member_id');
select throws_ok(
  $$ update public.tasks set handoff_grants = '{"capabilities":[],"budgetCents":999999,"dataScope":[]}'::jsonb where id = '81000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot widen handoff_grants');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, requester_member_id) values ('81000000-0000-4000-8000-0000000000a1', 'x', '81000000-0000-4000-8000-0000000001a1') $$,
  '42501', null, 'an agent token cannot insert a task with a requester');
select throws_ok(
  $$ select public.create_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000007a1', '81000000-0000-4000-8000-0000000006e9',
       '81000000-0000-4000-8000-0000000002a2', 't', '', '81000000-0000-4000-8000-0000000001a1',
       array['81000000-0000-4000-8000-0000000002a1', '81000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '42501', null, 'an agent token cannot call create_handoff_task');
select throws_ok(
  $$ select public.accept_handoff_task('81000000-0000-4000-8000-0000000000a1', '81000000-0000-4000-8000-0000000006a1', '81000000-0000-4000-8000-0000000007b1') $$,
  '42501', null, 'an agent token cannot call accept_handoff_task');

-- 11. RLS: a member sees their workspace's handoff tasks and nobody else's.
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.tasks where id = '81000000-0000-4000-8000-0000000006a1'), 1, 'a member of the workspace can read the handoff task');
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.tasks where id = '81000000-0000-4000-8000-0000000006a1'), 0, 'a member of another workspace cannot read it');
select is((select count(*)::int from public.tasks where workspace_id = '81000000-0000-4000-8000-0000000000a1'), 0, 'nor any other task of that workspace');
reset role;

select * from finish();
rollback;
