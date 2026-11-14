-- AGO-86: public.request_run_control is member-only, human-only and workspace-scoped; stop is final; the AGO-58
-- event function also records an agent credential refused on the control route.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-86).
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

-- Fixtures: A has a member and a viewer, B has an owner. Runs in each state a control request can meet.
insert into auth.users (id, instance_id, aud, role, email) values
  ('86000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago86-member@example.test'),
  ('86000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago86-viewer@example.test'),
  ('86000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago86-b@example.test');
insert into public.workspaces (id, name) values
  ('86aaaaaa-0000-0000-0000-000000000001', 'AGO-86 A'),
  ('86bbbbbb-0000-0000-0000-000000000001', 'AGO-86 B');
insert into public.members (workspace_id, user_id, role) values
  ('86aaaaaa-0000-0000-0000-000000000001', '86000000-0000-0000-0000-00000000000a', 'member'),
  ('86aaaaaa-0000-0000-0000-000000000001', '86000000-0000-0000-0000-00000000000d', 'viewer'),
  ('86bbbbbb-0000-0000-0000-000000000001', '86000000-0000-0000-0000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('86aaaaaa-0000-0000-0000-000000000003', '86aaaaaa-0000-0000-0000-000000000001', 'agent-a'),
  ('86bbbbbb-0000-0000-0000-000000000003', '86bbbbbb-0000-0000-0000-000000000001', 'agent-b');
insert into public.runs (id, workspace_id, agent_id) values
  ('86aaaaaa-0000-0000-0000-0000000000a1', '86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-000000000003'), -- queued
  ('86aaaaaa-0000-0000-0000-0000000000a2', '86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-000000000003'), -- paused
  ('86aaaaaa-0000-0000-0000-0000000000a3', '86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-000000000003'), -- succeeded
  ('86bbbbbb-0000-0000-0000-0000000000b1', '86bbbbbb-0000-0000-0000-000000000001', '86bbbbbb-0000-0000-0000-000000000003'); -- queued, B
update public.runs set status = 'paused' where id = '86aaaaaa-0000-0000-0000-0000000000a2';
update public.runs set status = 'succeeded' where id = '86aaaaaa-0000-0000-0000-0000000000a3';
insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
  ('86aaaaaa-0000-0000-0000-0000000000c1', '86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-000000000003',
   '86aaaaaa-0000-0000-0000-0000000000a1', repeat('c', 64), now() + interval '10 minutes');

-- 1-5. grants and shape
select is(
  (select count(*)::int from unnest(array['anon', 'service_role']) r
    where has_function_privilege(r, 'public.request_run_control(uuid,uuid,text)', 'EXECUTE')),
  0, 'anon and service_role cannot execute it');
select is(has_function_privilege('authenticated', 'public.request_run_control(uuid,uuid,text)', 'EXECUTE'), true, 'authenticated can');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.request_run_control(uuid,uuid,text)'::regprocedure and a.grantee = 0),
  0, 'PUBLIC holds no execute');
select is((select prosecdef from pg_proc where oid = 'public.request_run_control(uuid,uuid,text)'::regprocedure), true, 'security definer');
select is(
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.request_run_control(uuid,uuid,text)'::regprocedure),
  'search_path=""', 'search_path is pinned to empty');

-- 6-14. a member of A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'pause'),
  'accepted', 'a member can ask to pause a queued run');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a2', 'pause'),
  'not_applicable', 'a paused run cannot be asked to pause again');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a2', 'resume'),
  'accepted', 'a paused run can be asked to resume');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a2', 'stop'),
  'accepted', 'a paused run can be asked to stop');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a2', 'resume'),
  'not_applicable', 'stop is final: a stopped run cannot be asked to resume');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a3', 'stop'),
  'not_applicable', 'a finished run cannot be stopped');
select is(public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86bbbbbb-0000-0000-0000-0000000000b1', 'stop'),
  'not_applicable', 'workspace B''s run is not reachable through workspace A');
select throws_ok(
  $$ select public.request_run_control('86bbbbbb-0000-0000-0000-000000000001', '86bbbbbb-0000-0000-0000-0000000000b1', 'stop') $$,
  '42501', null, 'a member of A cannot control a run by naming workspace B');
select throws_ok(
  $$ select public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'delete') $$,
  '22023', null, 'an unknown action is refused');

-- 15. a viewer cannot control a run
select set_config('request.jwt.claims', '{"sub":"86000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
select throws_ok(
  $$ select public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'stop') $$,
  '42501', null, 'a viewer is refused');

-- 16-18. human only: an agent claim, no user, and anon are all refused
select set_config('request.jwt.claims', '{"sub":"86000000-0000-0000-0000-00000000000a","role":"authenticated","agent_id":"86aaaaaa-0000-0000-0000-000000000003"}', true);
select throws_ok(
  $$ select public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'stop') $$,
  '42501', null, 'a token that carries an agent claim is refused even with a member as subject');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$ select public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'stop') $$,
  '42501', null, 'a call with no user session is refused');
reset role;
set local role anon;
select throws_ok(
  $$ select public.request_run_control('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1', 'stop') $$,
  '42501', null, 'anon has no execute right');
reset role;

-- 19-22. what the accepted requests recorded (and what the refused ones did not)
select is(
  (select control_requested_by from private.run_checkpoints where run_id = '86aaaaaa-0000-0000-0000-0000000000a1'),
  '86000000-0000-0000-0000-00000000000a'::uuid, 'the pause request records the human behind it');
select isnt(
  (select stop_requested_at from private.run_checkpoints where run_id = '86aaaaaa-0000-0000-0000-0000000000a2'),
  null, 'the stop request is recorded');
select is((select count(*)::int from private.run_checkpoints where run_id = '86aaaaaa-0000-0000-0000-0000000000a3'), 0,
  'the refused stop on a finished run left no row');
select is(
  (select count(*)::int from private.run_checkpoints where run_id = '86aaaaaa-0000-0000-0000-0000000000a1' and stop_requested_at is not null),
  0, 'the refused calls (viewer, agent claim, anon) did not stop the queued run');

-- 23-28. the AGO-58 event function also records a refusal on the control route, and nothing else
set local role service_role;
select lives_ok(
  $$ select public.record_agent_approval_rejection('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1',
       '86aaaaaa-0000-0000-0000-000000000003', '86aaaaaa-0000-0000-0000-0000000000c1',
       '/api/runs/86aaaaaa-0000-0000-0000-0000000000a2/control', 'POST') $$,
  'a genuine credential refused on the control route is recorded');
reset role;
select is((select count(*)::int from public.run_events where type = 'error.raised' and payload ->> 'code' = 'control_route_rejected'), 1,
  'exactly one control_route_rejected event');
select is(
  (select payload from public.run_events where type = 'error.raised' and payload ->> 'code' = 'control_route_rejected'),
  jsonb_build_object('version', 1, 'code', 'control_route_rejected',
    'message', 'POST /api/runs/86aaaaaa-0000-0000-0000-0000000000a2/control', 'retryable', false),
  'the payload has the fixed shape');
set local role service_role;
select throws_ok(
  $$ select public.record_agent_approval_rejection('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1',
       '86aaaaaa-0000-0000-0000-000000000003', '86aaaaaa-0000-0000-0000-0000000000c1', '/api/runs/not-a-uuid/control', 'POST') $$,
  '22023', null, 'a malformed control route is refused');
select throws_ok(
  $$ select public.record_agent_approval_rejection('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1',
       '86aaaaaa-0000-0000-0000-000000000003', '86aaaaaa-0000-0000-0000-0000000000c1', '/api/capabilities', 'POST') $$,
  '22023', null, 'a route outside the human-only set is still refused');
select lives_ok(
  $$ select public.record_agent_approval_rejection('86aaaaaa-0000-0000-0000-000000000001', '86aaaaaa-0000-0000-0000-0000000000a1',
       '86aaaaaa-0000-0000-0000-000000000003', '86aaaaaa-0000-0000-0000-0000000000c1', '/api/approvals/x/decision', 'POST') $$,
  'the approval route still records (AGO-58 behaviour kept)');
reset role;

select * from finish();
rollback;
