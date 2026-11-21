-- AGO-81 functional acceptance (pgTAP): the API roles can neither run the handoff functions nor write any handoff
-- column, by actually trying it (the builder's test checks privileges; this one attempts the calls).
--   anon: cannot execute create_handoff_task / accept_handoff_task, cannot insert or update handoff data.
--   authenticated (a human member and a member carrying an agent claim): cannot widen a stored handoff, rewrite its
--   path, depth, sender or parent, nor re-point it at another agent. The stored row is unchanged afterwards.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-81).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email) values
  ('82000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago81-roles@example.test');
insert into public.workspaces (id, name) values ('82000000-0000-4000-8000-0000000000a1', 'AGO-81 roles');
insert into public.members (id, workspace_id, user_id, role) values
  ('82000000-0000-4000-8000-0000000001a1', '82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-00000000000a', 'member');
insert into public.agents (id, workspace_id, name) values
  ('82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000000a1', 'A'),
  ('82000000-0000-4000-8000-0000000002a2', '82000000-0000-4000-8000-0000000000a1', 'B'),
  ('82000000-0000-4000-8000-0000000002a3', '82000000-0000-4000-8000-0000000000a1', 'C');
insert into public.tasks (id, workspace_id, title, agent_id, handoff_from_agent_id, requester_member_id, handoff_depth, handoff_path, handoff_grants) values
  ('82000000-0000-4000-8000-0000000006a1', '82000000-0000-4000-8000-0000000000a1', 'handoff', '82000000-0000-4000-8000-0000000002a2',
   '82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000001a1', 1,
   array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[],
   '{"capabilities":[],"budgetCents":10,"dataScope":[]}'::jsonb);

-- anon
set local role anon;
select throws_ok(
  $$ select public.create_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000007a1', '82000000-0000-4000-8000-0000000006f1',
       '82000000-0000-4000-8000-0000000002a2', 't', '', '82000000-0000-4000-8000-0000000001a1',
       array['82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000002a2']::uuid[], 1,
       '{"capabilities":[],"budgetCents":1,"dataScope":[]}'::jsonb) $$,
  '42501', null, 'anon cannot execute create_handoff_task');
select throws_ok(
  $$ select public.accept_handoff_task('82000000-0000-4000-8000-0000000000a1', '82000000-0000-4000-8000-0000000006a1', '82000000-0000-4000-8000-0000000007b1') $$,
  '42501', null, 'anon cannot execute accept_handoff_task');
select throws_ok(
  $$ insert into public.tasks (workspace_id, title, handoff_from_agent_id, requester_member_id) values ('82000000-0000-4000-8000-0000000000a1', 'x', '82000000-0000-4000-8000-0000000002a1', '82000000-0000-4000-8000-0000000001a1') $$,
  '42501', null, 'anon cannot insert a task with handoff data');
select throws_ok(
  $$ update public.tasks set handoff_grants = '{"capabilities":[],"budgetCents":999,"dataScope":[]}'::jsonb where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'anon cannot widen handoff_grants');
reset role;

-- authenticated: a signed-in member carrying an agent claim
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"82000000-0000-4000-8000-00000000000a","role":"authenticated","agent_id":"82000000-0000-4000-8000-0000000002a2"}', true);
select throws_ok(
  $$ update public.tasks set handoff_path = array['82000000-0000-4000-8000-0000000002a3']::uuid[] where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot rewrite handoff_path');
select throws_ok(
  $$ update public.tasks set handoff_depth = 0 where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot rewrite handoff_depth');
select throws_ok(
  $$ update public.tasks set handoff_from_agent_id = '82000000-0000-4000-8000-0000000002a3' where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot rewrite the sender');
select throws_ok(
  $$ update public.tasks set parent_task_id = '82000000-0000-4000-8000-0000000006a1' where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot rewrite the parent task');
select throws_ok(
  $$ update public.tasks set handoff_run_id = gen_random_uuid() where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'an agent token cannot link a run as the accepting run');
-- a human member without an agent claim is not special either
select set_config('request.jwt.claims', '{"sub":"82000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok(
  $$ update public.tasks set requester_member_id = null where id = '82000000-0000-4000-8000-0000000006a1' $$,
  '42501', null, 'a signed-in member cannot clear the requester of a handoff');
reset role;

select results_eq(
  $$ select handoff_depth, requester_member_id, handoff_grants ->> 'budgetCents', cardinality(handoff_path)
       from public.tasks where id = '82000000-0000-4000-8000-0000000006a1' $$,
  $$ values (1::smallint, '82000000-0000-4000-8000-0000000001a1'::uuid, '10', 2) $$,
  'after every refused write the stored handoff is unchanged');

select * from finish();
rollback;
