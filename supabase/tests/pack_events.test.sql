-- AGO-192: pack_events, the audit trail of agent pack exports (pgTAP).
--   shape: workspace_id, RLS on, no INSERT/UPDATE/DELETE grant for any API role
--   record_pack_export: owner and member may export; viewer, non-member and signed-out are refused; the exporter is the
--     caller's own member id; names come from the agents table; a foreign or unknown agent id is refused
--   read: members and viewers of the workspace read their events, another workspace reads none
--   append-only: UPDATE, DELETE and TRUNCATE are refused for the table owner and for every API role
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, instance_id, aud, role, email) values
  ('19200000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago192-o@example.test'),
  ('19200000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago192-m@example.test'),
  ('19200000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago192-v@example.test'),
  ('19200000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago192-b@example.test');
insert into public.workspaces (id, name) values
  ('19aaaaaa-0000-4000-8000-000000000001', 'AGO-192 A'),
  ('19bbbbbb-0000-4000-8000-000000000001', 'AGO-192 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('19200000-0000-4000-8000-0000000001a1', '19aaaaaa-0000-4000-8000-000000000001', '19200000-0000-4000-8000-00000000000a', 'owner'),
  ('19200000-0000-4000-8000-0000000001a2', '19aaaaaa-0000-4000-8000-000000000001', '19200000-0000-4000-8000-00000000000c', 'member'),
  ('19200000-0000-4000-8000-0000000001a3', '19aaaaaa-0000-4000-8000-000000000001', '19200000-0000-4000-8000-00000000000d', 'viewer'),
  ('19200000-0000-4000-8000-0000000001b1', '19bbbbbb-0000-4000-8000-000000000001', '19200000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents) values
  ('19200000-0000-4000-8000-0000000002a1', '19aaaaaa-0000-4000-8000-000000000001', 'Zed', 'R', 'claude-haiku-5-5', 'p', 100),
  ('19200000-0000-4000-8000-0000000002a2', '19aaaaaa-0000-4000-8000-000000000001', 'Ann', 'R', 'claude-haiku-5-5', 'p', 100),
  ('19200000-0000-4000-8000-0000000002b1', '19bbbbbb-0000-4000-8000-000000000001', 'B agent', 'R', 'claude-haiku-5-5', 'p', 100);

-- 1. Shape and privileges.
select has_table('public', 'pack_events', 'pack_events exists');
select col_not_null('public', 'pack_events', 'workspace_id', 'pack_events carries workspace_id');
select is((select relrowsecurity from pg_class where oid = 'public.pack_events'::regclass), true, 'RLS is on');
select is((select count(*)::int from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'pack_events'
              and grantee in ('anon', 'authenticated', 'service_role', 'public')
              and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no API role holds INSERT, UPDATE, DELETE or TRUNCATE on pack_events');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'record_pack_export'
              and p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('service_role', p.oid, 'execute')),
  1, 'record_pack_export is SECURITY DEFINER, executable by authenticated only');

-- 2. Owner exports two agents: exporter and names come from the database, in name order.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19200000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1','19200000-0000-4000-8000-0000000002a2']::uuid[], 3, repeat('a', 64))$$,
  'an owner can record an export');
select is((select exported_by from public.pack_events order by created_at limit 1),
  '19200000-0000-4000-8000-0000000001a1'::uuid, 'the exporter is the caller''s own member id');
select is((select agent_names from public.pack_events order by created_at limit 1),
  array['Ann', 'Zed'], 'agent names come from the agents table, sorted');
select is((select kind from public.pack_events order by created_at limit 1), 'export', 'kind is export');

-- 3. A member can export; a viewer cannot; an unknown or foreign agent id is refused; bad checksum refused.
select set_config('request.jwt.claims', '{"sub":"19200000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select lives_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1']::uuid[], 0, repeat('b', 64))$$, 'a member can record an export');
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002b1']::uuid[], 0, repeat('c', 64))$$,
  'P0002', null, 'an agent of another workspace is refused');
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1','19200000-0000-4000-8000-0000000002ff']::uuid[], 0, repeat('c', 64))$$,
  'P0002', null, 'one unknown agent id refuses the whole export event');
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array[]::uuid[], 0, repeat('c', 64))$$, 'P0002', null, 'an empty agent list is refused');
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1']::uuid[], 0, 'not-a-hash')$$,
  '23514', null, 'a checksum that is not a sha-256 hex digest is refused');
select set_config('request.jwt.claims', '{"sub":"19200000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1']::uuid[], 0, repeat('d', 64))$$,
  '42501', null, 'a viewer cannot export');
select set_config('request.jwt.claims', '{"sub":"19200000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.record_pack_export('19aaaaaa-0000-4000-8000-000000000001',
  array['19200000-0000-4000-8000-0000000002a1']::uuid[], 0, repeat('d', 64))$$,
  '42501', null, 'a member of another workspace cannot export here');

-- 4. Reads: members and viewers see their workspace's events; another workspace sees none.
select is((select count(*)::int from public.pack_events), 0, 'a member of workspace B reads none of workspace A''s events');
select set_config('request.jwt.claims', '{"sub":"19200000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.pack_events), 2, 'a viewer of workspace A reads its events');

-- 5. Append-only: refused for the API role and for the table owner.
select throws_ok($$update public.pack_events set skill_count = 9$$, '42501', null, 'an API role cannot UPDATE');
select throws_ok($$delete from public.pack_events$$, '42501', null, 'an API role cannot DELETE');
reset role;
select throws_ok($$update public.pack_events set skill_count = 9$$, '42501', 'pack_events is append-only: UPDATE is not allowed',
  'the table owner cannot UPDATE either');
select throws_ok($$delete from public.pack_events$$, '42501', 'pack_events is append-only: DELETE is not allowed',
  'the table owner cannot DELETE either');
select throws_ok($$truncate public.pack_events$$, '42501', 'pack_events is append-only: TRUNCATE is not allowed',
  'the table owner cannot TRUNCATE either');

select * from finish();
rollback;
