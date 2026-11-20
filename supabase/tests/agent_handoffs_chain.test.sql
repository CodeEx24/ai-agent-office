-- AGO-81 round 2 (pgTAP): a handoff is never wider than the sender on EVERY hop.
--   hop 2 and 3: the narrowed set must fit inside the PARENT handoff's set (B cannot pass on to C what A did not pass
--   on to B, even though B holds it); the budget is bounded (the sender's remaining budget, the parent's on hop 2+);
--   a non-empty data scope is refused (no stored scope exists); tier and mode are validated; the requester must be an
--   active member; the path CHECK refuses a NULL entry; the two foreign key indexes exist.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-81).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures. Workspace W: members M (active) and R (removed later), agents A, B, C, D.
insert into auth.users (id, instance_id, aud, role, email) values
  ('82000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago81c-m@example.test'),
  ('82000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago81c-r@example.test');
insert into public.workspaces (id, name) values ('82000000-0000-4000-8000-0000000000a1', 'AGO-81 chain');
insert into public.members (id, workspace_id, user_id, role) values
  ('82000000-0000-4000-8000-0000000001a1', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-00000000000a', 'member'),
  ('82000000-0000-4000-8000-0000000001a2', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-00000000000c', 'member');
insert into public.agents (id, workspace_id, name) values
  ('82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000000a1', 'A'),
  ('82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000000a1', 'B'),
  ('82000000-0000-4000-8000-0000000002a3', '82000000-0000-4000-8000-0000000000a1', 'C'),
  ('82000000-0000-4000-8000-0000000002a4', '82000000-0000-4000-8000-0000000000a1', 'D');
insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode, enabled) values
  ('82000000-0000-4000-8000-0000000000a1', 'vault.read', 'Read vault', 0, 'workspace', 'automatic', true),
  ('82000000-0000-4000-8000-0000000000a1', 'tasks.manage', 'Manage tasks', 1, 'workspace', 'automatic', true)
on conflict (workspace_id, key) do update set tier = excluded.tier, enabled = true;
-- Every agent holds both capabilities on its own: only the handoffs narrow them.
insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode)
select '82000000-0000-4000-8000-0000000000a1', a.id, c.cap, c.tier, 'automatic'
  from (values ('82000000-0000-4000-8000-0000000002a1'::uuid), ('82000000-0000-4000-8000-0000000002a2'::uuid),
               ('82000000-0000-4000-8000-0000000002a3'::uuid), ('82000000-0000-4000-8000-0000000002a4'::uuid)) a(id),
       (values ('vault.read', 0), ('tasks.manage', 1)) c(cap, tier);
insert into public.tasks (id, workspace_id, title, agent_id, created_by) values
  ('82000000-0000-4000-8000-0000000006a0', '82000000-0000-4000-8000-0000000000a1', 'root', '82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000001a1');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006a0', '82000000-0000-4000-8000-0000000002a1');

set local role service_role;

-- Hop 1: A hands B only vault.read, with a budget of 100 cents.
select lives_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006a1',
       '82000000-0000-4000-8000-0000000002a2', 'h1', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"vault.read","tier":0,"mode":"automatic"}],"budgetCents":100,"dataScope":[]}'::jsonb) $$,
  'hop 1: a narrowed handoff is created');

-- Budget bounds on hop 1: above the sender's remaining budget (default daily budget 500) is refused.
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c1',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":501,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a budget above the sender''s remaining budget is refused');
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c2',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":-1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a negative budget is refused');
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c3',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1.5,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a fractional budget is refused');
-- A data scope is refused: no agent has a stored scope, so nothing can be passed on.
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c4',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":["projects/"]}'::jsonb) $$,
  '22023', null, 'a non-empty data scope is refused');
-- Tier and mode are validated.
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c5',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"vault.read","tier":9,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a tier outside 0..4 is refused');
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006c6',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"vault.read","tier":0,"mode":"bogus"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a mode other than automatic or approval is refused');

-- Hop 2: B (running the handoff task a1) cannot pass on tasks.manage: it holds it, but A did not pass it on to B.
reset role;
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006a1', '82000000-0000-4000-8000-0000000002a2');
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000006c7',
       '82000000-0000-4000-8000-0000000002a3', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3']::uuid[], 2,
       '{"capabilities":[{"capabilityKey":"tasks.manage","tier":1,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'hop 2: a capability the parent handoff did not pass on is refused, though the sender holds it');
-- ... and a budget above the parent's (100) is refused too, even though the sender's own remaining budget is 500.
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000006c8',
       '82000000-0000-4000-8000-0000000002a3', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3']::uuid[], 2,
       '{"capabilities":[],"budgetCents":101,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'hop 2: a budget above the parent handoff''s budget is refused');
select lives_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000006a2',
       '82000000-0000-4000-8000-0000000002a3', 'h2', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3']::uuid[], 2,
       '{"capabilities":[{"capabilityKey":"vault.read","tier":0,"mode":"automatic"}],"budgetCents":100,"dataScope":[]}'::jsonb) $$,
  'hop 2: passing on what the parent passed on, within the parent''s budget, works');

-- Hop 3: C (running a2) is held to the same rule: tasks.manage was dropped on hop 1 and stays dropped.
reset role;
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('82000000-0000-4000-8000-0000000007c1', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006a2', '82000000-0000-4000-8000-0000000002a3');
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007c1', '82000000-0000-4000-8000-0000000006c9',
       '82000000-0000-4000-8000-0000000002a4', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3', '82000000-0000-4000-8000-0000000002a4']::uuid[], 3,
       '{"capabilities":[{"capabilityKey":"tasks.manage","tier":1,"mode":"automatic"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'hop 3: a capability dropped on hop 1 cannot come back');
select lives_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007c1', '82000000-0000-4000-8000-0000000006a3',
       '82000000-0000-4000-8000-0000000002a4', 'h3', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3', '82000000-0000-4000-8000-0000000002a4']::uuid[], 3,
       '{"capabilities":[{"capabilityKey":"vault.read","tier":0,"mode":"automatic"}],"budgetCents":10,"dataScope":[]}'::jsonb) $$,
  'hop 3: the narrowed set passes on');

-- Round 3: hop 2+ is capped by the parent's REMAINING budget. Task a1 (budget 100) already spent 60 on run b1; a huge or
-- non-numeric cost in the same task must not raise (the cast sits inside a CASE) and counts as 0.
reset role;
insert into public.run_events (workspace_id, run_id, type, payload) values
  ('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', 'budget.usage', '{"cost_cents": 60}'::jsonb),
  ('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', 'budget.usage', '{"cost_cents": 99999999999999999999}'::jsonb),
  ('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', 'budget.usage', '{"cost_cents": "abc"}'::jsonb);
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000006e1',
       '82000000-0000-4000-8000-0000000002a3', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3']::uuid[], 2,
       '{"capabilities":[],"budgetCents":41,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'hop 2: a budget above the parent''s REMAINING budget (100 - 60) is refused');
select lives_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007b1', '82000000-0000-4000-8000-0000000006e2',
       '82000000-0000-4000-8000-0000000002a3', 'h2b', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000002a3']::uuid[], 2,
       '{"capabilities":[],"budgetCents":40,"dataScope":[]}'::jsonb) $$,
  'hop 2: exactly the parent''s remaining budget works, and a huge or non-numeric cost does not raise');

-- A run whose agent is not the task's assignee is not a sender (round 3).
reset role;
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('82000000-0000-4000-8000-0000000007e9', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006a0', '82000000-0000-4000-8000-0000000002a4');
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007e9', '82000000-0000-4000-8000-0000000006e3',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a4', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  'P0002', null, 'a run on a task assigned to another agent is refused');
-- A grant with no tier or no mode is a bad grant, not a silent pass.
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006e4',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[{"capabilityKey":"vault.read"}],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', 'bad handoff grants', 'a capability with no tier or mode is refused with the clear error');

-- The requester must still be an active member: a task created by R, then R is removed.
reset role;
insert into public.tasks (id, workspace_id, title, agent_id, created_by) values
  ('82000000-0000-4000-8000-0000000006f0', '82000000-0000-4000-8000-0000000000a1', 'root of R', '82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000001a2');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('82000000-0000-4000-8000-0000000007f0', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006f0', '82000000-0000-4000-8000-0000000002a1');
update public.members set removed_at = now() where id = '82000000-0000-4000-8000-0000000001a2';
set local role service_role;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007f0', '82000000-0000-4000-8000-0000000006d1',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a2',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '22023', null, 'a requester who is no longer an active member is refused');
reset role;
select is((select count(*)::int from public.tasks where id::text like '82000000-0000-4000-8000-0000000006c%' or id::text like '82000000-0000-4000-8000-0000000006d%'),
  0, 'every refused handoff wrote nothing');

-- Table backstops: a NULL entry in the path is refused by the CHECK, and the two foreign key indexes exist.
select ok(
  (select pg_get_constraintdef(oid) like '%array_position%' from pg_constraint where conname = 'tasks_handoff_path_shape'),
  'the path CHECK refuses a NULL entry (array_position)');
select has_index('public', 'tasks', 'tasks_handoff_from_agent_idx', 'handoff_from_agent_id has an index');
select has_index('public', 'tasks', 'tasks_requester_member_idx', 'requester_member_id has an index');

select * from finish();
rollback;
