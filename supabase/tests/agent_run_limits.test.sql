-- AGO-166: per-agent run limits (agents.run_limits, public.set_agent_run_limits).
--   AC2  an owner can set limits; members and viewers cannot; out-of-bounds values are rejected by the CHECK
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, instance_id, aud, role, email) values
  ('16600000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago166-o@example.test'),
  ('16600000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago166-m@example.test'),
  ('16600000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago166-v@example.test'),
  ('16600000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago166-b@example.test');
insert into public.workspaces (id, name) values
  ('166aaaaa-0000-4000-8000-000000000001', 'AGO-166 A'),
  ('166bbbbb-0000-4000-8000-000000000001', 'AGO-166 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('16600000-0000-4000-8000-0000000001a1', '166aaaaa-0000-4000-8000-000000000001', '16600000-0000-4000-8000-00000000000a', 'owner'),
  ('16600000-0000-4000-8000-0000000001a2', '166aaaaa-0000-4000-8000-000000000001', '16600000-0000-4000-8000-00000000000c', 'member'),
  ('16600000-0000-4000-8000-0000000001a3', '166aaaaa-0000-4000-8000-000000000001', '16600000-0000-4000-8000-00000000000d', 'viewer'),
  ('16600000-0000-4000-8000-0000000001b1', '166bbbbb-0000-4000-8000-000000000001', '16600000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('16600000-0000-4000-8000-0000000002a1', '166aaaaa-0000-4000-8000-000000000001', 'agent-a');

-- 1-2. the column exists, null by default, and has no grant for the API roles
select has_column('public', 'agents', 'run_limits', 'agents.run_limits exists');
select is((select run_limits from public.agents where id = '16600000-0000-4000-8000-0000000002a1'), null, 'null by default');

-- 3-4. the CHECK itself (as postgres): in-bounds accepted, out-of-bounds rejected
select lives_ok($$update public.agents set run_limits = '{"maxSteps":10,"maxTokens":2000,"maxWallMs":60000}' where id = '16600000-0000-4000-8000-0000000002a1'$$, 'in-bounds limits are accepted');
select throws_ok($$update public.agents set run_limits = '{"maxSteps":201}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'maxSteps above the cap is rejected');
select throws_ok($$update public.agents set run_limits = '{"maxTokens":999}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'maxTokens below the floor is rejected');
select throws_ok($$update public.agents set run_limits = '{"maxWallMs":840001}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'maxWallMs above the cap is rejected');
select throws_ok($$update public.agents set run_limits = '{"maxSteps":1.5}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'a non-integer is rejected');
select throws_ok($$update public.agents set run_limits = '{"maxSteps":"10"}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'a string is rejected');
select throws_ok($$update public.agents set run_limits = '{"unlimited":true}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'an unknown key is rejected');
select throws_ok($$update public.agents set run_limits = '[1]' where id = '16600000-0000-4000-8000-0000000002a1'$$, '23514', null, 'a non-object is rejected');

-- 11. an owner sets limits through the function
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"16600000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.set_agent_run_limits('166aaaaa-0000-4000-8000-000000000001', '16600000-0000-4000-8000-0000000002a1', '{"maxSteps":5}')$$, 'an owner can set run limits');
select is((select run_limits from public.agents where id = '16600000-0000-4000-8000-0000000002a1'), '{"maxSteps":5}'::jsonb, 'the owner''s value is stored');

-- 13. a member can neither call the function nor write the column directly
select set_config('request.jwt.claims', '{"sub":"16600000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.set_agent_run_limits('166aaaaa-0000-4000-8000-000000000001', '16600000-0000-4000-8000-0000000002a1', '{"maxSteps":150}')$$, '42501', null, 'a member cannot set run limits');

-- 14. direct column writes are denied for every API role (checked as a viewer: no grant exists)
select set_config('request.jwt.claims', '{"sub":"16600000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$update public.agents set run_limits = '{"maxSteps":150}' where id = '16600000-0000-4000-8000-0000000002a1'$$, '42501', null, 'no direct column write for any API role');

select * from finish();
rollback;
