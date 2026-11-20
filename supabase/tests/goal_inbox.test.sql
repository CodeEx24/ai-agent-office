-- AGO-113: the goal inbox (pgTAP).
--   goals has RLS and no write grant; submit_goal is the only writer (SECURITY DEFINER, search_path pinned, authenticated only);
--   a member's submit records the goal and the Manager's task together; empty, zero-width-only and too-long text is
--   refused by the function AND by the CHECK constraints; viewers, strangers, removed members and signed-out callers
--   are refused; another workspace cannot read the goals; no Manager means nothing is stored; a failing task insert
--   rolls the goal back (atomicity).
-- Run: pnpm exec supabase test db (inside the db lock as AGO-113).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures. A: one member, one viewer, one removed member, an active Manager (plus an archived one and a Writer).
-- B: an owner (a stranger to A). C: a member and no Manager. D: a member and an agent whose role is " MANAGER ".
insert into auth.users (id, instance_id, aud, role, email) values
  ('11300000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-member@example.test'),
  ('11300000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-viewer@example.test'),
  ('11300000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-removed@example.test'),
  ('11300000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-b@example.test'),
  ('11300000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-c@example.test'),
  ('11300000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113-d@example.test');
insert into public.workspaces (id, name) values
  ('113aaaaa-0000-0000-0000-000000000001', 'AGO-113 A'),
  ('113bbbbb-0000-0000-0000-000000000001', 'AGO-113 B'),
  ('113ccccc-0000-0000-0000-000000000001', 'AGO-113 C'),
  ('113ddddd-0000-0000-0000-000000000001', 'AGO-113 D');
insert into public.members (id, workspace_id, user_id, role, removed_at) values
  ('113aaaaa-0000-0000-0000-0000000000a1', '113aaaaa-0000-0000-0000-000000000001', '11300000-0000-0000-0000-00000000000a', 'member', null),
  ('113aaaaa-0000-0000-0000-0000000000a2', '113aaaaa-0000-0000-0000-000000000001', '11300000-0000-0000-0000-00000000000d', 'viewer', null),
  ('113aaaaa-0000-0000-0000-0000000000a3', '113aaaaa-0000-0000-0000-000000000001', '11300000-0000-0000-0000-00000000000e', 'member', now()),
  ('113bbbbb-0000-0000-0000-0000000000b1', '113bbbbb-0000-0000-0000-000000000001', '11300000-0000-0000-0000-00000000000b', 'owner', null),
  ('113ccccc-0000-0000-0000-0000000000c1', '113ccccc-0000-0000-0000-000000000001', '11300000-0000-0000-0000-00000000000c', 'member', null),
  ('113ddddd-0000-0000-0000-0000000000d1', '113ddddd-0000-0000-0000-000000000001', '11300000-0000-0000-0000-0000000000d1', 'member', null);
insert into public.agents (id, workspace_id, name, role, archived_at, created_at) values
  ('113aaaaa-0000-0000-0000-000000000b01', '113aaaaa-0000-0000-0000-000000000001', 'archived-manager', 'Manager', now(), now() - interval '2 days'),
  ('113aaaaa-0000-0000-0000-000000000b02', '113aaaaa-0000-0000-0000-000000000001', 'manager', 'Manager', null, now() - interval '1 day'),
  ('113aaaaa-0000-0000-0000-000000000b03', '113aaaaa-0000-0000-0000-000000000001', 'writer', 'Writer', null, now()),
  ('113ccccc-0000-0000-0000-000000000b01', '113ccccc-0000-0000-0000-000000000001', 'writer', 'Writer', null, now()),
  ('113ddddd-0000-0000-0000-000000000b01', '113ddddd-0000-0000-0000-000000000001', 'boss', ' MANAGER ', null, now());

-- 1. Function shape and privileges.
select is(
  (select count(*)::int from unnest(array['anon', 'service_role']) r
    where has_function_privilege(r, 'public.submit_goal(uuid,text)', 'EXECUTE')),
  0, 'anon and service_role cannot execute submit_goal');
select is(has_function_privilege('authenticated', 'public.submit_goal(uuid,text)', 'EXECUTE'), true, 'authenticated can execute it');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.submit_goal(uuid,text)'::regprocedure and a.grantee = 0),
  0, 'PUBLIC holds no execute');
select is((select prosecdef from pg_proc where oid = 'public.submit_goal(uuid,text)'::regprocedure), true, 'submit_goal is security definer');
select is(
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.submit_goal(uuid,text)'::regprocedure),
  'search_path=""', 'search_path is pinned to empty');

-- 2. The table: RLS on, read-only for authenticated, nothing for anon.
select is((select relrowsecurity from pg_class where oid = 'public.goals'::regclass), true, 'goals has RLS');
select is(
  (select count(*)::int from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    where has_table_privilege('authenticated', 'public.goals', p) or has_table_privilege('anon', 'public.goals', p)
       or (p in ('INSERT', 'UPDATE')
           and (has_any_column_privilege('authenticated', 'public.goals', p) or has_any_column_privilege('anon', 'public.goals', p)))),
  0, 'no API role holds a write privilege on goals');
select is(has_table_privilege('anon', 'public.goals', 'SELECT'), false, 'anon cannot read goals');
select is(has_column_privilege('authenticated', 'public.tasks', 'goal_id', 'UPDATE'), false, 'tasks.goal_id is in no update grant');
select is(has_column_privilege('authenticated', 'public.tasks', 'goal_id', 'INSERT'), false, 'tasks.goal_id is in no insert grant');

-- 3. A member of A submits a goal: the goal and the Manager's task appear together.
create temp table ctx (k text primary key, v uuid);
grant all on ctx to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
insert into ctx select 'g1', public.submit_goal('113aaaaa-0000-0000-0000-000000000001', E'  Grow​ signups\r\nby 20%  ');
select ok((select v from ctx where k = 'g1') is not null, 'submit_goal returns the goal id');
select is((select count(*)::int from public.goals where workspace_id = '113aaaaa-0000-0000-0000-000000000001'), 1, 'one goal was stored');
select is((select text from public.goals where id = (select v from ctx where k = 'g1')), E'Grow signups\nby 20%',
  'the text is stored normalised (zero-width removed, CRLF to LF, trimmed)');
select is((select created_by from public.goals where id = (select v from ctx where k = 'g1')), '113aaaaa-0000-0000-0000-0000000000a1'::uuid,
  'created_by is the caller''s member id, taken from auth.uid()');
select is(
  (select count(*)::int from public.tasks where goal_id = (select v from ctx where k = 'g1')), 1, 'one task is linked to the goal');
select is(
  (select agent_id from public.tasks where goal_id = (select v from ctx where k = 'g1')),
  '113aaaaa-0000-0000-0000-000000000b02'::uuid, 'the task is assigned to the active Manager (not the archived one, not another role)');
select is(
  (select workspace_id from public.tasks where goal_id = (select v from ctx where k = 'g1')),
  '113aaaaa-0000-0000-0000-000000000001'::uuid, 'the task is in the same workspace');
select is(
  (select created_by from public.tasks where goal_id = (select v from ctx where k = 'g1')),
  '113aaaaa-0000-0000-0000-0000000000a1'::uuid, 'the task is attributed to the member');
select is(
  (select title from public.tasks where goal_id = (select v from ctx where k = 'g1')),
  'Plan goal: Grow signups by 20%', 'the task title names the goal');
select is(
  (select position('signups' in description) from public.tasks where goal_id = (select v from ctx where k = 'g1')),
  0, 'the task description does not embed the goal text');

-- 4. Empty goals are refused (SQL repeats the app rule); nothing is stored.
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', '') $$, '22023', null, 'an empty goal is refused');
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', E'  \n\t ') $$, '22023', null, 'a whitespace-only goal is refused');
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', E'​‌‍⁠﻿') $$, '22023', null, 'a zero-width-only goal is refused');
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', E'  ​') $$, '22023', null, 'a non-breaking-space goal is refused');
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', null) $$, '22023', null, 'a null goal is refused');
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', repeat('a', 5001)) $$, '22023', null, 'a 5001-character goal is refused');
select lives_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', repeat('a', 5000)) $$, 'a 5000-character goal is accepted');
select is((select count(*)::int from public.goals where workspace_id = '113aaaaa-0000-0000-0000-000000000001'), 2,
  'only the two valid goals were stored');
select is((select count(*)::int from public.tasks where workspace_id = '113aaaaa-0000-0000-0000-000000000001' and goal_id is not null), 2,
  'and each has exactly one task');

-- 5. Direct writes are refused: a goal cannot be created without going through submit_goal.
select throws_ok(
  $$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', 'sneaky', '113aaaaa-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'a member cannot insert a goal directly');
select throws_ok($$ update public.goals set text = 'changed' where workspace_id = '113aaaaa-0000-0000-0000-000000000001' $$, '42501', null, 'a member cannot update a goal');
select throws_ok($$ delete from public.goals where workspace_id = '113aaaaa-0000-0000-0000-000000000001' $$, '42501', null, 'a member cannot delete a goal');

-- 6. Who may call it.
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'viewer goal') $$, '42501', null, 'a viewer cannot submit a goal');
select is((select count(*)::int from public.goals where workspace_id = '113aaaaa-0000-0000-0000-000000000001'), 2, 'a viewer can read the workspace''s goals');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000e","role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'removed goal') $$, '42501', null, 'a removed member cannot submit a goal');
select is((select count(*)::int from public.goals), 0, 'a removed member reads no goals');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'stranger goal') $$, '42501', null,
  'a member of another workspace cannot submit a goal into A');
select is((select count(*)::int from public.goals), 0, 'another workspace cannot read A''s goals');
select is((select count(*)::int from public.tasks where goal_id is not null), 0, 'another workspace cannot read A''s goal tasks');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'no user') $$, '42501', null, 'a caller with no user id is refused');
select throws_ok($$ select public.submit_goal(null, 'no workspace') $$, '42501', null, 'a null workspace is refused');
-- Human only: a token that carries an agent claim is refused even when its subject is a member of the workspace.
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated","agent_id":"11300000-0000-0000-0000-0000000000a9"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'agent goal') $$, '42501', null, 'a token with an agent_id claim is refused');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated","run_id":"11300000-0000-0000-0000-0000000000b9"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'run goal') $$, '42501', null, 'a token with a run_id claim is refused');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated","agent_credential":"x"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'credential goal') $$, '42501', null, 'a token with an agent_credential claim is refused');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"service_role"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'service goal') $$, '42501', null, 'a token whose role is not authenticated is refused');
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.goals where text in ('agent goal', 'run goal', 'credential goal', 'service goal')), 0, 'a refused agent-claim submit stores nothing');

-- 7. No Manager: refused with P0002 and nothing is stored (workspace C has only a Writer).
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113ccccc-0000-0000-0000-000000000001', 'a goal with nobody to plan it') $$, 'P0002', null,
  'no Manager: the submit is refused');
select is((select count(*)::int from public.goals), 0, 'no Manager: no goal was stored');
select is((select count(*)::int from public.tasks where workspace_id = '113ccccc-0000-0000-0000-000000000001'), 0, 'no Manager: no task was stored');

-- 8. The role is matched ignoring case and spaces.
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
select lives_ok($$ select public.submit_goal('113ddddd-0000-0000-0000-000000000001', 'goal for the boss') $$, 'a role of " MANAGER " counts as a Manager');
select is((select agent_id from public.tasks where workspace_id = '113ddddd-0000-0000-0000-000000000001' and goal_id is not null),
  '113ddddd-0000-0000-0000-000000000b01'::uuid, 'and receives the task');

-- 9. Atomicity: if the task cannot be written, the goal is rolled back with it.
reset role;
create function public.ago113_fail_boom() returns trigger language plpgsql as $f$
begin
  if new.title like 'Plan goal: boom%' then raise exception 'boom' using errcode = 'P0001'; end if;
  return new;
end;
$f$;
create trigger ago113_fail_task before insert on public.tasks for each row execute function public.ago113_fail_boom();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11300000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select throws_ok($$ select public.submit_goal('113aaaaa-0000-0000-0000-000000000001', 'boom goal') $$, 'P0001', 'boom', 'a failing task insert fails the whole submit');
select is((select count(*)::int from public.goals where text = 'boom goal'), 0, 'atomicity: no goal exists without its task');

-- 10. The CHECK constraints refuse bad text even for a role that bypasses the function.
reset role;
drop trigger ago113_fail_task on public.tasks;
select throws_ok($$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', '', '113aaaaa-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'CHECK: an empty goal cannot be inserted directly');
select throws_ok($$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', E' \n\t ', '113aaaaa-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'CHECK: a whitespace-only goal cannot be inserted directly');
select throws_ok($$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', E'​‍﻿', '113aaaaa-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'CHECK: a zero-width-only goal cannot be inserted directly');
select throws_ok($$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', repeat('a', 5001), '113aaaaa-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'CHECK: an over-long goal cannot be inserted directly');
select throws_ok($$ insert into public.goals (workspace_id, text, created_by) values ('113aaaaa-0000-0000-0000-000000000001', 'x', '113bbbbb-0000-0000-0000-0000000000b1') $$,
  '23503', null, 'FK: created_by must be a member of the same workspace');

select * from finish();
rollback;
