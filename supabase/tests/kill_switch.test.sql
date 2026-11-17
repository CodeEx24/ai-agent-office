-- AGO-84: the kill switch. public.activate_kill_switch / release_kill_switch are owner-only, human-only and workspace
-- scoped; activation latches the scope, flags its live runs for a stop and revokes its credentials without deleting
-- anything; the latch blocks credential issuance in the database; release never revives a run or a credential; the
-- AGO-58 event function also records an agent credential refused on the kill routes.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-84).
begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

-- Fixtures: workspace A has an owner and a member, workspace B has an owner. A has two agents; B has one.
insert into auth.users (id, instance_id, aud, role, email) values
  ('84000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago84-owner@example.test'),
  ('84000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago84-member@example.test'),
  ('84000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago84-b@example.test');
insert into public.workspaces (id, name) values
  ('84aaaaaa-0000-0000-0000-000000000001', 'AGO-84 A'),
  ('84bbbbbb-0000-0000-0000-000000000001', 'AGO-84 B');
insert into public.members (workspace_id, user_id, role) values
  ('84aaaaaa-0000-0000-0000-000000000001', '84000000-0000-0000-0000-00000000000a', 'owner'),
  ('84aaaaaa-0000-0000-0000-000000000001', '84000000-0000-0000-0000-00000000000d', 'member'),
  ('84bbbbbb-0000-0000-0000-000000000001', '84000000-0000-0000-0000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('84aaaaaa-0000-0000-0000-000000000003', '84aaaaaa-0000-0000-0000-000000000001', 'agent-a1'),
  ('84aaaaaa-0000-0000-0000-000000000004', '84aaaaaa-0000-0000-0000-000000000001', 'agent-a2'),
  ('84bbbbbb-0000-0000-0000-000000000003', '84bbbbbb-0000-0000-0000-000000000001', 'agent-b1');
-- A1: r1 queued, r2 running, r3 paused, r5 succeeded. A2: r4 queued. B1: rb queued.
insert into public.runs (id, workspace_id, agent_id) values
  ('84aaaaaa-0000-0000-0000-0000000000a1', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003'),
  ('84aaaaaa-0000-0000-0000-0000000000a2', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003'),
  ('84aaaaaa-0000-0000-0000-0000000000a3', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003'),
  ('84aaaaaa-0000-0000-0000-0000000000a4', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000004'),
  ('84aaaaaa-0000-0000-0000-0000000000a5', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003'),
  ('84bbbbbb-0000-0000-0000-0000000000b1', '84bbbbbb-0000-0000-0000-000000000001', '84bbbbbb-0000-0000-0000-000000000003');
insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
  ('84aaaaaa-0000-0000-0000-0000000000c1', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003',
   '84aaaaaa-0000-0000-0000-0000000000a1', repeat('c', 64), now() + interval '10 minutes'),
  ('84aaaaaa-0000-0000-0000-0000000000c2', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003',
   '84aaaaaa-0000-0000-0000-0000000000a2', repeat('d', 64), now() + interval '10 minutes'),
  ('84aaaaaa-0000-0000-0000-0000000000c4', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000004',
   '84aaaaaa-0000-0000-0000-0000000000a4', repeat('e', 64), now() + interval '10 minutes'),
  ('84bbbbbb-0000-0000-0000-0000000000c9', '84bbbbbb-0000-0000-0000-000000000001', '84bbbbbb-0000-0000-0000-000000000003',
   '84bbbbbb-0000-0000-0000-0000000000b1', repeat('f', 64), now() + interval '10 minutes');
update public.runs set status = 'running' where id = '84aaaaaa-0000-0000-0000-0000000000a2';
update public.runs set status = 'paused' where id = '84aaaaaa-0000-0000-0000-0000000000a3';
update public.runs set status = 'succeeded' where id = '84aaaaaa-0000-0000-0000-0000000000a5';

-- 1-8. grants, shape and the latch table
select is(
  (select count(*)::int from unnest(array['anon', 'service_role']) r
    where has_function_privilege(r, 'public.activate_kill_switch(uuid,text,uuid)', 'EXECUTE')),
  0, 'anon and service_role cannot execute activate_kill_switch');
select is(
  (select count(*)::int from unnest(array['anon', 'service_role']) r
    where has_function_privilege(r, 'public.release_kill_switch(uuid,text,uuid)', 'EXECUTE')),
  0, 'anon and service_role cannot execute release_kill_switch');
select is(
  (select count(*)::int from unnest(array['public.activate_kill_switch(uuid,text,uuid)', 'public.release_kill_switch(uuid,text,uuid)']) f
    where has_function_privilege('authenticated', f, 'EXECUTE')),
  2, 'authenticated can execute both');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid in ('public.activate_kill_switch(uuid,text,uuid)'::regprocedure, 'public.release_kill_switch(uuid,text,uuid)'::regprocedure)
      and a.grantee = 0),
  0, 'PUBLIC holds no execute on either');
select is(
  (select count(*)::int from pg_proc where prosecdef
     and oid in ('public.activate_kill_switch(uuid,text,uuid)'::regprocedure, 'public.release_kill_switch(uuid,text,uuid)'::regprocedure)),
  2, 'both are security definer');
select is(
  (select count(*)::int from pg_proc where array_to_string(proconfig, ',') = 'search_path=""'
     and oid in ('public.activate_kill_switch(uuid,text,uuid)'::regprocedure, 'public.release_kill_switch(uuid,text,uuid)'::regprocedure)),
  2, 'search_path is pinned to empty on both');
select is((select relrowsecurity from pg_class where oid = 'private.kill_switches'::regclass), true,
  'RLS is enabled on private.kill_switches');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r
    where has_table_privilege(r, 'private.kill_switches', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),
  0, 'no web role or service_role has any privilege on private.kill_switches (deny-all)');

-- 9-10. a member (not an owner) is refused
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'a member cannot pull the kill switch');
select throws_ok(
  $$ select public.release_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'a member cannot release it');

-- 11. an owner of B cannot reach A
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'an owner of B cannot pull the switch by naming workspace A');

-- 12-15. human only: an agent claim, no user and anon are refused (even with an owner as subject)
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000a","role":"authenticated","agent_id":"84aaaaaa-0000-0000-0000-000000000003"}', true);
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'a token that carries an agent claim cannot activate, even with an owner as subject');
select throws_ok(
  $$ select public.release_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'a token that carries an agent claim cannot release');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'a call with no user session is refused');
reset role;
set local role anon;
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null) $$,
  '42501', null, 'anon has no execute right');
reset role;

-- 16-19. input is checked
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'agent', null) $$,
  '22023', null, 'an agent scope needs an agent');
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', '84aaaaaa-0000-0000-0000-000000000003') $$,
  '22023', null, 'a workspace scope must not name an agent');
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'everything', null) $$,
  '22023', null, 'an unknown scope is refused');
select throws_ok(
  $$ select public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'agent', '84bbbbbb-0000-0000-0000-000000000003') $$,
  '22023', null, 'an agent of another workspace is refused');

-- 20. the owner pulls the switch for agent A1 only: its 3 live runs are flagged and its 2 live credentials revoked
select is(
  public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'agent', '84aaaaaa-0000-0000-0000-000000000003'),
  '{"runs_stopped": 3, "credentials_revoked": 2}'::jsonb,
  'agent scope: A1''s queued, running and paused runs are flagged and its two live credentials revoked');
reset role;

-- 21-25. what it recorded, and what it left alone
select is(
  (select count(*)::int from private.run_checkpoints
    where workspace_id = '84aaaaaa-0000-0000-0000-000000000001' and stop_requested_at is not null),
  3, 'exactly A1''s three live runs carry a stop flag (the finished run does not)');
select is(
  (select count(*)::int from private.run_checkpoints where run_id = '84aaaaaa-0000-0000-0000-0000000000a4' and stop_requested_at is not null),
  0, 'agent A2''s run is not flagged by an A1 switch');
select is(
  (select count(*)::int from public.agent_credentials
    where id in ('84aaaaaa-0000-0000-0000-0000000000c1', '84aaaaaa-0000-0000-0000-0000000000c2') and revoked_at is not null),
  2, 'both of A1''s credentials are revoked');
select is(
  (select count(*)::int from public.agent_credentials
    where id in ('84aaaaaa-0000-0000-0000-0000000000c4', '84bbbbbb-0000-0000-0000-0000000000c9') and revoked_at is null),
  2, 'A2''s credential and workspace B''s credential are still live');
select is(
  (select control_requested_by from private.run_checkpoints where run_id = '84aaaaaa-0000-0000-0000-0000000000a1'),
  '84000000-0000-0000-0000-00000000000a'::uuid, 'the flag records the owner behind it');

-- 26-27. the whole workspace: only what is not flagged yet is counted, and a repeat changes nothing
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(
  public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null),
  '{"runs_stopped": 1, "credentials_revoked": 1}'::jsonb,
  'workspace scope: A2''s queued run is flagged and its credential revoked (A1''s are already done)');
select is(
  public.activate_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null),
  '{"runs_stopped": 0, "credentials_revoked": 0}'::jsonb,
  'a repeat activation changes nothing');
reset role;

-- 28-33. one live latch per scope, workspace B untouched, nothing deleted, no run event written
select is(
  (select count(*)::int from private.kill_switches where workspace_id = '84aaaaaa-0000-0000-0000-000000000001' and released_at is null),
  2, 'one live latch for the agent scope and one for the workspace scope (a repeat adds none)');
select is(
  (select count(*)::int from private.run_checkpoints where workspace_id = '84bbbbbb-0000-0000-0000-000000000001'),
  0, 'workspace B''s runs were not flagged');
select is(
  (select count(*)::int from public.agent_credentials where id = '84bbbbbb-0000-0000-0000-0000000000c9' and revoked_at is null),
  1, 'workspace B''s credential is still live');
select is(
  (select count(*)::int from public.run_events where workspace_id = '84aaaaaa-0000-0000-0000-000000000001' and type = 'run.stopped'),
  0, 'the function writes no run event (the worker writes run.stopped)');
select is(
  (select count(*)::int from public.agent_credentials where workspace_id = '84aaaaaa-0000-0000-0000-000000000001'),
  3, 'state preserved: no credential row was deleted');
select is(
  (select count(*)::int from public.runs where workspace_id = '84aaaaaa-0000-0000-0000-000000000001'),
  5, 'state preserved: no run was deleted');

-- 34-35. the database-side issuance latch (runs created after the switch)
insert into public.runs (id, workspace_id, agent_id) values
  ('84aaaaaa-0000-0000-0000-0000000000a6', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000004'),
  ('84aaaaaa-0000-0000-0000-0000000000a7', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003'),
  ('84bbbbbb-0000-0000-0000-0000000000b2', '84bbbbbb-0000-0000-0000-000000000001', '84bbbbbb-0000-0000-0000-000000000003');
select throws_ok(
  $$ insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
       ('84aaaaaa-0000-0000-0000-0000000000c6', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000004',
        '84aaaaaa-0000-0000-0000-0000000000a6', repeat('1', 64), now() + interval '10 minutes') $$,
  '42501', null, 'a live workspace switch blocks issuing a credential, even to a plain insert');
select lives_ok(
  $$ insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
       ('84bbbbbb-0000-0000-0000-0000000000ca', '84bbbbbb-0000-0000-0000-000000000001', '84bbbbbb-0000-0000-0000-000000000003',
        '84bbbbbb-0000-0000-0000-0000000000b2', repeat('2', 64), now() + interval '10 minutes') $$,
  'workspace B can still be issued a credential');

-- 36-39. release: only the latch changes
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(
  public.release_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'workspace', null),
  '{"runs_stopped": 0, "credentials_revoked": 0}'::jsonb,
  'releasing the workspace switch reports no run or credential change');
reset role;
select lives_ok(
  $$ insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
       ('84aaaaaa-0000-0000-0000-0000000000c6', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000004',
        '84aaaaaa-0000-0000-0000-0000000000a6', repeat('1', 64), now() + interval '10 minutes') $$,
  'after the workspace release, agent A2 can be issued a credential again');
select throws_ok(
  $$ insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
       ('84aaaaaa-0000-0000-0000-0000000000c7', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003',
        '84aaaaaa-0000-0000-0000-0000000000a7', repeat('3', 64), now() + interval '10 minutes') $$,
  '42501', null, 'the live agent switch still blocks agent A1');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"84000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(
  public.release_kill_switch('84aaaaaa-0000-0000-0000-000000000001', 'agent', '84aaaaaa-0000-0000-0000-000000000003'),
  '{"runs_stopped": 0, "credentials_revoked": 0}'::jsonb,
  'releasing the agent switch reports no run or credential change');
reset role;

-- 40-43. after release: A1 can be issued a credential, and nothing stopped or revoked came back
select lives_ok(
  $$ insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, expires_at) values
       ('84aaaaaa-0000-0000-0000-0000000000c7', '84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-000000000003',
        '84aaaaaa-0000-0000-0000-0000000000a7', repeat('4', 64), now() + interval '10 minutes') $$,
  'after the agent release, A1 can be issued a credential again');
select is(
  (select count(*)::int from private.run_checkpoints
    where workspace_id = '84aaaaaa-0000-0000-0000-000000000001' and stop_requested_at is not null),
  4, 'release never un-stops a run: all four flagged runs keep their stop flag');
select is(
  (select count(*)::int from public.agent_credentials
    where id in ('84aaaaaa-0000-0000-0000-0000000000c1', '84aaaaaa-0000-0000-0000-0000000000c2', '84aaaaaa-0000-0000-0000-0000000000c4')
      and revoked_at is not null),
  3, 'release never un-revokes a credential');
select is(
  (select count(*)::int from private.kill_switches where workspace_id = '84aaaaaa-0000-0000-0000-000000000001' and released_at is null),
  0, 'no live latch is left and both rows are kept for review');

-- 44-48. the AGO-58 event function also records an agent credential refused on the kill routes, and nothing else
set local role service_role;
select lives_ok(
  $$ select public.record_agent_approval_rejection('84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-0000000000a1',
       '84aaaaaa-0000-0000-0000-000000000003', '84aaaaaa-0000-0000-0000-0000000000c1', '/api/control/kill', 'POST') $$,
  'a genuine credential refused on the kill route is recorded');
select lives_ok(
  $$ select public.record_agent_approval_rejection('84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-0000000000a1',
       '84aaaaaa-0000-0000-0000-000000000003', '84aaaaaa-0000-0000-0000-0000000000c1', '/api/control/kill/release', 'POST') $$,
  'a genuine credential refused on the release route is recorded');
select throws_ok(
  $$ select public.record_agent_approval_rejection('84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-0000000000a1',
       '84aaaaaa-0000-0000-0000-000000000003', '84aaaaaa-0000-0000-0000-0000000000c1', '/api/control/killer', 'POST') $$,
  '22023', null, 'a look-alike route is not a human-only route');
select lives_ok(
  $$ select public.record_agent_approval_rejection('84aaaaaa-0000-0000-0000-000000000001', '84aaaaaa-0000-0000-0000-0000000000a1',
       '84aaaaaa-0000-0000-0000-000000000003', '84aaaaaa-0000-0000-0000-0000000000c1', '/api/approvals', 'POST') $$,
  'the approval route is still recorded');
reset role;
select is((select count(*)::int from public.run_events where type = 'error.raised' and payload ->> 'code' = 'control_route_rejected'), 2,
  'exactly two control_route_rejected events, one per kill route');

select * from finish();
rollback;
