-- AGO-58: record_agent_approval_rejection appends one fixed-shape event, only for a genuine credential, bounded.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-58).
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- Fixtures: two workspaces, each with an agent, a run and an issued credential.
insert into public.workspaces (id, name) values
  ('a5800000-0000-0000-0000-000000000001', 'AGO-58 A'),
  ('b5800000-0000-0000-0000-000000000001', 'AGO-58 B');
insert into public.agents (id, workspace_id, name) values
  ('a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-000000000001', 'agent-a'),
  ('b5800000-0000-0000-0000-000000000003', 'b5800000-0000-0000-0000-000000000001', 'agent-b');
insert into public.runs (id, workspace_id, agent_id) values
  ('a5800000-0000-0000-0000-000000000006', 'a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000003'),
  ('b5800000-0000-0000-0000-000000000006', 'b5800000-0000-0000-0000-000000000001', 'b5800000-0000-0000-0000-000000000003');
insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
  ('a5800000-0000-0000-0000-0000000000c1', 'a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000003',
   'a5800000-0000-0000-0000-000000000006', repeat('a', 64), now() + interval '10 minutes'),
  ('b5800000-0000-0000-0000-0000000000c1', 'b5800000-0000-0000-0000-000000000001', 'b5800000-0000-0000-0000-000000000003',
   'b5800000-0000-0000-0000-000000000006', repeat('b', 64), now() + interval '10 minutes');

-- 1-4. grants (catalog): who may execute, and the function's shape
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, 'public.record_agent_approval_rejection(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE')),
  0, 'anon and authenticated cannot execute it');
select is(
  (select has_function_privilege('service_role', 'public.record_agent_approval_rejection(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE')),
  true, 'service_role (the web server-only client) is the one role that can');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.record_agent_approval_rejection(uuid,uuid,uuid,uuid,text,text)'::regprocedure and a.grantee = 0),
  0, 'PUBLIC holds no execute');
select is(
  (select prosecdef from pg_proc
    where oid = 'public.record_agent_approval_rejection(uuid,uuid,uuid,uuid,text,text)'::regprocedure),
  true, 'security definer');
select is(
  (select array_to_string(proconfig, ',') from pg_proc
    where oid = 'public.record_agent_approval_rejection(uuid,uuid,uuid,uuid,text,text)'::regprocedure),
  'search_path=""', 'search_path is pinned to empty');

-- 5-7. a genuine credential appends exactly one fixed-shape event in its own run
set local role service_role;
select lives_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/approvals/x/decision', 'POST') $$,
  'a genuine credential records the rejection');
reset role;
select is((select count(*)::int from public.run_events where type = 'error.raised' and payload ->> 'code' = 'approval_route_rejected'), 1, 'exactly one event');
select is(
  (select payload from public.run_events where type = 'error.raised' and payload ->> 'code' = 'approval_route_rejected'),
  jsonb_build_object('version', 1, 'code', 'approval_route_rejected', 'message', 'POST /api/approvals/x/decision', 'retryable', false),
  'the payload is exactly version, code, message (method and route) and retryable');

-- 8-11. cross-workspace and made-up credentials are denied and write nothing
set local role service_role;
select throws_ok(
  $$ select public.record_agent_approval_rejection('b5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/approvals', 'POST') $$,
  '42501', null, 'workspace B with workspace A''s credential and run is denied');
select throws_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'b5800000-0000-0000-0000-0000000000c1', '/api/approvals', 'POST') $$,
  '42501', null, 'another workspace''s credential id is denied');
select throws_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', gen_random_uuid(), '/api/approvals', 'POST') $$,
  '42501', null, 'an unknown credential id is denied');
select throws_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'b5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/approvals', 'POST') $$,
  '42501', null, 'the wrong agent for the credential is denied');

-- 12-13. fixed shape: only approval routes and the five methods
select throws_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/capabilities', 'POST') $$,
  '22023', null, 'a route outside /api/approvals is refused');
select throws_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/approvals', 'TRACE') $$,
  '22023', null, 'an unsupported method is refused');
reset role;

-- 14. denied calls wrote nothing: still the one event from before
select is((select count(*)::int from public.run_events where type = 'error.raised' and payload ->> 'code' = 'approval_route_rejected'), 1, 'denied calls appended nothing');

-- 15-16. flood bound: 25 calls leave at most 20 events for the run in a minute, and the log stays append-only
set local role service_role;
select lives_ok(
  $$ select public.record_agent_approval_rejection('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-000000000006',
       'a5800000-0000-0000-0000-000000000003', 'a5800000-0000-0000-0000-0000000000c1', '/api/approvals', 'POST')
     from generate_series(1, 25) $$,
  '25 rapid calls do not error');
reset role;
select is((select count(*)::int from public.run_events where type = 'error.raised' and payload ->> 'code' = 'approval_route_rejected'), 20, 'the run holds at most 20 per minute');

select * from finish();
rollback;
