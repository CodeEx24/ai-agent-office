-- AGO-82 QA: negative and abuse cases on top of workspace_roles_rls.test.sql.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- fixtures (as postgres): a = owner of A, c = member of A, d = viewer of A,
-- g = owner of A whose membership was soft-removed, b = owner of B, f = no workspace yet
insert into auth.users (id, instance_id, aud, role, email) values
  ('82100000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-a@example.test'),
  ('82100000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-b@example.test'),
  ('82100000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-c@example.test'),
  ('82100000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-d@example.test'),
  ('82100000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-f@example.test'),
  ('82100000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82qa-g@example.test');
insert into public.workspaces (id, name) values
  ('82a10000-0000-0000-0000-000000000001', 'QA WS A'),
  ('82b10000-0000-0000-0000-000000000001', 'QA WS B');
insert into public.members (workspace_id, user_id, role, removed_at) values
  ('82a10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-00000000000a', 'owner', null),
  ('82a10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-00000000000c', 'member', null),
  ('82a10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-00000000000d', 'viewer', null),
  ('82a10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000010', 'owner', now()),
  ('82b10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-00000000000b', 'owner', null);

-- Structure: who can write what, independent of any one user
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('workspaces', 'members') and cmd in ('INSERT', 'DELETE', 'ALL')),
  0, 'AC2: no INSERT, DELETE or ALL policy exists on workspaces or members');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'members' and cmd = 'UPDATE'),
  0, 'AC2: no UPDATE policy exists on members, so nobody can change a role through the API');
select is(has_table_privilege('authenticated', 'public.members', 'INSERT, UPDATE, DELETE'), false, 'AC2: authenticated has no write privilege on members');
select is(has_table_privilege('authenticated', 'public.workspaces', 'INSERT, DELETE'), false, 'AC2: authenticated cannot insert or delete workspaces directly');
select is(has_table_privilege('anon', 'public.members', 'SELECT, INSERT, UPDATE, DELETE'), false, 'AC3: anon has no privilege on members');
select is(has_table_privilege('anon', 'public.workspaces', 'SELECT, INSERT, UPDATE, DELETE'), false, 'AC3: anon has no privilege on workspaces');
select is(has_function_privilege('authenticated', 'private.role_rank(text)', 'EXECUTE'), false, 'authenticated cannot call private.role_rank directly');

-- onboard_current_user: definer, pinned search_path, no way to name another user
select is(
  (select prosecdef from pg_proc where oid = 'public.onboard_current_user(text)'::regprocedure),
  true, 'AC3: onboard_current_user is SECURITY DEFINER');
select ok(
  (select coalesce(proconfig, '{}') @> array['search_path=""'] from pg_proc where oid = 'public.onboard_current_user(text)'::regprocedure),
  'AC3: onboard_current_user pins search_path to the empty path');
select is(
  (select pronargs::int from pg_proc where oid = 'public.onboard_current_user(text)'::regprocedure),
  1, 'AC3: onboard_current_user takes only a workspace name, so it cannot be pointed at another user');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'onboard_current_user'),
  1, 'AC3: there is exactly one onboard_current_user overload');

select ok(
  (select coalesce(proconfig, '{}') @> array['search_path=""'] from pg_proc where oid = 'private.is_member(uuid,text)'::regprocedure),
  'AC2: private.is_member pins search_path to the empty path');

-- owner A abuses their powers: no role changes, no memberships, no cross-tenant writes
set local role authenticated;
set local request.jwt.claims = '{"sub":"82100000-0000-0000-0000-00000000000a","role":"authenticated"}';
select throws_ok($$update public.members set role = 'viewer' where user_id = '82100000-0000-0000-0000-00000000000a'$$, '42501', null, 'AC2: an owner cannot change their own role');
select throws_ok($$update public.members set role = 'owner' where user_id = '82100000-0000-0000-0000-00000000000d'$$, '42501', null, 'AC2: an owner cannot promote another member through the API');
select throws_ok($$update public.members set removed_at = null where user_id = '82100000-0000-0000-0000-000000000010'$$, '42501', null, 'AC2: an owner cannot restore a removed member through the API');
select throws_ok($$insert into public.members (workspace_id, user_id, role) values ('82a10000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-00000000000f', 'viewer')$$, '42501', null, 'AC2: an owner cannot add members through the API (invites are AGO-112)');
select throws_ok($$delete from public.members where user_id = '82100000-0000-0000-0000-00000000000d'$$, '42501', null, 'AC2: an owner cannot delete memberships through the API');
select throws_ok($$insert into public.workspaces (name) values ('Sneaky')$$, '42501', null, 'AC3: a signed-in user cannot insert a workspace directly (only through the RPC)');
select is((select count(*)::int from public.members where workspace_id = '82b10000-0000-0000-0000-000000000001'), 0, 'AC3: owner A reads none of workspace B''s members');

-- a viewer cannot rename even by guessing the id of their own workspace, and cannot read B
set local request.jwt.claims = '{"sub":"82100000-0000-0000-0000-00000000000d","role":"authenticated"}';
with u as (update public.workspaces set name = 'Hijacked' where id = '82a10000-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'AC2: a viewer cannot rename the workspace');
select is((select count(*)::int from public.workspaces where id = '82b10000-0000-0000-0000-000000000001'), 0, 'AC3: a viewer of A cannot see workspace B by id');

-- a removed OWNER loses owner powers immediately (not only read access)
set local request.jwt.claims = '{"sub":"82100000-0000-0000-0000-000000000010","role":"authenticated"}';
with u as (update public.workspaces set name = 'Ex-owner rename' where id = '82a10000-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'AC2: a soft-removed owner cannot rename the workspace');
select is(private.is_member('82a10000-0000-0000-0000-000000000001'), false, 'AC2: is_member is false for a soft-removed owner at the lowest minimum');
select is(private.is_member('82a10000-0000-0000-0000-000000000001', 'owner'), false, 'AC2: is_member is false for a soft-removed owner at the owner minimum');

-- the writes above did not change anything (checked as postgres)
reset role;
select is(
  (select string_agg(role, ',' order by user_id) from public.members where workspace_id = '82a10000-0000-0000-0000-000000000001'),
  'owner,member,viewer,owner', 'roles in workspace A are unchanged after every abuse attempt');
select is((select name from public.workspaces where id = '82a10000-0000-0000-0000-000000000001'), 'QA WS A', 'workspace A keeps its name after every abuse attempt');

select * from finish();
rollback;
