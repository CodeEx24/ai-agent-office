-- AGO-122 QA: seed data safety and tenant isolation, on top of seed_data.test.sql.
-- Needs the seed loaded (`supabase db reset` or `pnpm db:seed`). Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- fixture (as postgres): an unrelated user with their own workspace B, to prove the seed does not leak
insert into auth.users (id, instance_id, aud, role, email) values
  ('12290000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago122qa-b@example.test');
insert into public.workspaces (id, name) values ('12290000-0000-4000-8000-0000000000b1', 'QA WS B');
insert into public.members (workspace_id, user_id, role) values
  ('12290000-0000-4000-8000-0000000000b1', '12290000-0000-4000-8000-00000000000b', 'owner');

-- AC1: exact contents, owner membership, safe defaults
select is((select count(*)::int from public.workspaces where name = 'Seed Workspace'), 1, 'AC1: exactly one seed workspace');
select is((select count(*)::int from public.skills where workspace_id = '12200001-0000-4000-8000-000000000001'), 3, 'AC1: exactly 3 starter skills');
select is(
  (select role from public.members where workspace_id = '12200001-0000-4000-8000-000000000001' and user_id = '12200010-0000-4000-8000-000000000001' and removed_at is null),
  'owner', 'AC1: the seed user is an active owner of the seed workspace');
select is((select count(*)::int from public.members where workspace_id = '12200001-0000-4000-8000-000000000001'), 1, 'AC1: the seed workspace has no other members');
select is(
  (select string_agg(name, ',' order by name) from public.agents where workspace_id = '12200001-0000-4000-8000-000000000001'),
  'Reviewer,Scout,Scribe', 'AC1: the three agents are Scout, Scribe and Reviewer');
select is((select count(*)::int from public.agents where workspace_id = '12200001-0000-4000-8000-000000000001' and mode = 'strict' and status = 'idle'), 3, 'AC1: all three agents are strict and idle');
select is((select count(*)::int from public.tasks where workspace_id = '12200001-0000-4000-8000-000000000001' and status = 'todo'), 5, 'AC1: all five tasks are todo');
select is((select count(*)::int from public.tasks where workspace_id = '12200001-0000-4000-8000-000000000001' and agent_id is null), 2, 'AC1: two tasks are unassigned, so a human picks who takes them');
select is((select count(*)::int from public.agent_capabilities where workspace_id = '12200001-0000-4000-8000-000000000001' and tier <> 0), 0, 'AC1: every seeded capability is tier 0');
select is(
  (select count(*)::int from public.agent_capabilities c join public.members m on m.id = c.granted_by where c.workspace_id = '12200001-0000-4000-8000-000000000001' and m.role = 'owner'),
  3, 'AC1: every capability was granted by the human owner, not by an agent');

-- Security: nothing fakes history, decisions or credentials
select is((select count(*)::int from public.run_events where workspace_id = '12200001-0000-4000-8000-000000000001'), 0, 'security: the seed created no run_events');
select is(
  (select count(*)::int from public.runs where workspace_id = '12200001-0000-4000-8000-000000000001')
  + (select count(*)::int from public.approvals where workspace_id = '12200001-0000-4000-8000-000000000001'),
  0, 'security: the seed created no runs or approvals');
select is(
  (select count(*)::int from auth.users where id = '12200010-0000-4000-8000-000000000001' and (encrypted_password is not null or phone is not null or raw_user_meta_data::text ~* '(token|secret|key)')),
  0, 'security: the seed user has no password, phone or secret-looking metadata');
select is((select count(*)::int from auth.identities where user_id = '12200010-0000-4000-8000-000000000001'), 0, 'security: the seed user has no sign-in identity');

-- RLS with seed data present: the seed owner sees only their workspace
set local role authenticated;
set local request.jwt.claims = '{"sub":"12200010-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '12200001-0000-4000-8000-000000000001'), 1, 'RLS: the seed owner reads the seed workspace');
select is((select count(*)::int from public.workspaces where id = '12290000-0000-4000-8000-0000000000b1'), 0, 'RLS: the seed owner cannot read another user''s workspace');
select is((select count(*)::int from public.members where workspace_id = '12290000-0000-4000-8000-0000000000b1'), 0, 'RLS: the seed owner cannot read another workspace''s members');
select throws_ok($$insert into public.members (workspace_id, user_id, role) values ('12200001-0000-4000-8000-000000000001', '12290000-0000-4000-8000-00000000000b', 'owner')$$, '42501', null, 'RLS: even the seed owner cannot add members through the API');

-- an unrelated user cannot see any seed data
set local request.jwt.claims = '{"sub":"12290000-0000-4000-8000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '12200001-0000-4000-8000-000000000001'), 0, 'RLS: another workspace''s owner cannot read the seed workspace');
select is((select count(*)::int from public.members where workspace_id = '12200001-0000-4000-8000-000000000001'), 0, 'RLS: another workspace''s owner cannot read the seed members');
-- agents, tasks and skills have no policy or authenticated grant until AGO-107, so reads are denied outright
select throws_ok($$select count(*) from public.agents where workspace_id = '12200001-0000-4000-8000-000000000001'$$, '42501', null, 'RLS: another workspace''s owner cannot read the seed agents');
select throws_ok($$select count(*) from public.tasks where workspace_id = '12200001-0000-4000-8000-000000000001'$$, '42501', null, 'RLS: another workspace''s owner cannot read the seed tasks');
select throws_ok($$select count(*) from public.skills where workspace_id = '12200001-0000-4000-8000-000000000001'$$, '42501', null, 'RLS: another workspace''s owner cannot read the seed skills');

-- anon sees nothing at all
set local role anon;
select throws_ok($$select count(*) from public.workspaces$$, '42501', null, 'RLS: anon cannot read workspaces, seed present');
select throws_ok($$select count(*) from public.agents$$, '42501', null, 'RLS: anon cannot read agents, seed present');

select * from finish();
rollback;
