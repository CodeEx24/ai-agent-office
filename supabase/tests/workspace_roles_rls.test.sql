-- AGO-82: roles, membership-based RLS on workspaces/members, onboarding RPC.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

-- fixtures (as postgres): a = owner of A, c = member of A, d = viewer of A, e = removed from A,
-- b = owner of B, f = no workspace yet
insert into auth.users (id, instance_id, aud, role, email) values
  ('82000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-a@example.test'),
  ('82000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-c@example.test'),
  ('82000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-d@example.test'),
  ('82000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-e@example.test'),
  ('82000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-b@example.test'),
  ('82000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago82-f@example.test');
insert into public.workspaces (id, name) values
  ('82aaaaaa-0000-0000-0000-000000000001', 'WS A'),
  ('82bbbbbb-0000-0000-0000-000000000001', 'WS B');
insert into public.members (workspace_id, user_id, role, removed_at) values
  ('82aaaaaa-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000a', 'owner', null),
  ('82aaaaaa-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000c', 'member', null),
  ('82aaaaaa-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000d', 'viewer', null),
  ('82aaaaaa-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000e', 'member', now()),
  ('82bbbbbb-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000b', 'owner', null);

-- roles are a closed set
select throws_ok(
  $$insert into public.members (workspace_id, user_id, role) values ('82bbbbbb-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000f', 'admin')$$,
  '23514', null, 'AC2: a role outside owner/member/viewer is rejected');

-- helper-level checks, as c (member of A)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
select is(private.is_member('82aaaaaa-0000-0000-0000-000000000001'), true, 'is_member: member passes the viewer minimum');
select is(private.is_member('82aaaaaa-0000-0000-0000-000000000001', 'member'), true, 'is_member: member passes the member minimum');
select is(private.is_member('82aaaaaa-0000-0000-0000-000000000001', 'owner'), false, 'is_member: member fails the owner minimum');
select is(private.is_member('82bbbbbb-0000-0000-0000-000000000001'), false, 'is_member: another workspace is false');
select is(private.is_member('82aaaaaa-0000-0000-0000-000000000001', 'superuser'), false, 'is_member: unknown role name denies');

-- AC3: a sees only workspace A and its members
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select results_eq($$select name from public.workspaces$$, $$values ('WS A')$$, 'AC3: owner A sees only workspace A');
select is((select count(*)::int from public.members where workspace_id = '82bbbbbb-0000-0000-0000-000000000001'), 0, 'AC3: A cannot read B''s members');
select is((select count(*)::int from public.members), 4, 'owner A sees A''s 3 active members and the removed one');

-- b sees only B
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select results_eq($$select name from public.workspaces$$, $$values ('WS B')$$, 'AC3: owner B sees only workspace B');
select is((select count(*)::int from public.members where workspace_id = '82aaaaaa-0000-0000-0000-000000000001'), 0, 'AC3: B cannot read A''s members');

-- viewer d: reads A, cannot write
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.workspaces), 1, 'viewer can read the workspace');
select is((select count(*)::int from public.members), 3, 'viewer sees active members only (not the removed one)');
with u as (update public.workspaces set name = 'hacked' where id = '82aaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'viewer cannot rename the workspace (0 rows)');

-- member c cannot rename, and nobody can touch roles or memberships through the API
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
with u as (update public.workspaces set name = 'hacked' where id = '82aaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'member cannot rename the workspace (owner only)');
select throws_ok($$update public.members set role = 'owner' where user_id = '82000000-0000-0000-0000-00000000000c'$$,
  '42501', null, 'a member cannot promote themselves (no UPDATE privilege)');
select throws_ok($$insert into public.members (workspace_id, user_id, role) values ('82aaaaaa-0000-0000-0000-000000000001', '82000000-0000-0000-0000-00000000000f', 'owner')$$,
  '42501', null, 'a member cannot insert memberships');
select throws_ok($$delete from public.members where role = 'viewer'$$, '42501', null, 'a member cannot delete memberships');

-- owner a can rename, but only the name column
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
with u as (update public.workspaces set name = 'WS A renamed' where id = '82aaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 1, 'owner can rename the workspace');
select throws_ok($$update public.workspaces set id = gen_random_uuid()$$, '42501', null, 'owner cannot change the workspace id (column grant)');

-- removed user e has no access
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000e","role":"authenticated"}', true);
select is((select count(*)::int from public.workspaces), 0, 'a soft-removed member sees nothing');

-- anon has nothing
reset role;
set local role anon;
select throws_ok($$select 1 from public.workspaces$$, '42501', null, 'anon cannot read workspaces');
select throws_ok($$select public.onboard_current_user('x')$$, '42501', null, 'anon cannot call the onboarding RPC');

-- onboarding RPC as f (no workspace): creates workspace + owner membership, idempotent
reset role;
create temp table onboard_ids (first_id uuid, second_id uuid) on commit drop;
grant all on onboard_ids to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000f","role":"authenticated"}', true);
insert into onboard_ids values (public.onboard_current_user('  My Office  '), null);
update onboard_ids set second_id = public.onboard_current_user('Other name');
select is((select first_id = second_id from onboard_ids), true, 'AC1: onboarding twice returns the same workspace (idempotent)');
select is((select count(*)::int from public.members where user_id = '82000000-0000-0000-0000-00000000000f' and role = 'owner'), 1, 'AC1: exactly one owner membership exists');
select is((select name from public.workspaces where id = (select first_id from onboard_ids)), 'My Office', 'AC1: workspace created with the trimmed name');

-- onboarding input and identity checks (f already has a workspace; validation runs first)
select throws_ok($$select public.onboard_current_user('   ')$$, '22023', null, 'onboarding rejects a blank name');
select throws_ok($$select public.onboard_current_user(repeat('x', 121))$$, '22023', null, 'onboarding rejects a 121-character name');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.onboard_current_user('No Sub')$$, '28000', null, 'onboarding without a user identity is refused');

-- cross-tenant write: owner of B cannot rename A
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
with u as (update public.workspaces set name = 'cross' where id = '82aaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'owner of B cannot rename workspace A (0 rows)');

-- removed member e sees no members; non-owner member c does not see the removed row
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000e","role":"authenticated"}', true);
select is((select count(*)::int from public.members), 0, 'a soft-removed member sees no members');
select set_config('request.jwt.claims', '{"sub":"82000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
select is((select count(*)::int from public.members where removed_at is not null), 0, 'a non-owner member does not see removed rows');

reset role;

-- function privileges: the helper is authenticated-only, the RPC is authenticated-only
select is(has_function_privilege('anon', 'private.is_member(uuid,text)', 'EXECUTE'), false, 'anon cannot execute private.is_member');
select is(has_function_privilege('authenticated', 'public.onboard_current_user(text)', 'EXECUTE'), true, 'authenticated can execute the onboarding RPC');
select is(has_function_privilege('anon', 'public.onboard_current_user(text)', 'EXECUTE'), false, 'anon cannot execute the onboarding RPC');
select * from finish();
rollback;
