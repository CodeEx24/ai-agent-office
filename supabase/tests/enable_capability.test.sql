-- AGO-85: risky capabilities cannot be enabled while a prerequisite check fails.
--   AC1  enable_capability() is owner only, fails closed on a missing, failing, errored, timed out, not-run or stale
--        attestation, and `capabilities.enabled` cannot be updated directly through the API any more
--   AC2  (the runs in CI and at enable time are covered by the worker and web Vitest suites)
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('85000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85-o@example.test'),
  ('85000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85-m@example.test'),
  ('85000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85-v@example.test'),
  ('85000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85-b@example.test');
insert into public.workspaces (id, name) values
  ('85aaaaaa-0000-4000-8000-000000000001', 'AGO-85 A'),
  ('85bbbbbb-0000-4000-8000-000000000001', 'AGO-85 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('85000000-0000-4000-8000-0000000001a1', '85aaaaaa-0000-4000-8000-000000000001', '85000000-0000-4000-8000-00000000000a', 'owner'),
  ('85000000-0000-4000-8000-0000000001a2', '85aaaaaa-0000-4000-8000-000000000001', '85000000-0000-4000-8000-00000000000c', 'member'),
  ('85000000-0000-4000-8000-0000000001a3', '85aaaaaa-0000-4000-8000-000000000001', '85000000-0000-4000-8000-00000000000d', 'viewer'),
  ('85000000-0000-4000-8000-0000000001b1', '85bbbbbb-0000-4000-8000-000000000001', '85000000-0000-4000-8000-00000000000b', 'owner');

-- capability ids by key (A and B), readable by the test roles
create temp table t_cap as
  select workspace_id, key, id from public.capabilities
   where workspace_id in ('85aaaaaa-0000-4000-8000-000000000001', '85bbbbbb-0000-4000-8000-000000000001');
grant select on t_cap to authenticated, anon, service_role;
-- every starter capability starts enabled; turn the ones under test off
update public.capabilities set enabled = false
  where workspace_id in ('85aaaaaa-0000-4000-8000-000000000001', '85bbbbbb-0000-4000-8000-000000000001')
    and key in ('code.run', 'web.browse', 'message.send_outbound', 'tasks.manage');
-- the worker's report: everything passes, just now
insert into public.capability_prerequisite_status (workspace_id, check_name, status, reason, checked_at)
select '85aaaaaa-0000-4000-8000-000000000001', n, 'pass', null, now()
  from unnest(array['sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash']) as n;

-- 1-9. shape and grants
select has_table('public', 'capability_prerequisite_status', 'the attestation table exists');
select col_not_null('public', 'capability_prerequisite_status', 'workspace_id', 'it carries workspace_id');
select is((select relrowsecurity from pg_class where oid = 'public.capability_prerequisite_status'::regclass), true, 'RLS is on');
select is((select count(*)::int from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'capability_prerequisite_status'
              and grantee in ('anon', 'authenticated', 'public') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no signed-in or anonymous role can write the attestation table');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname in ('enable_capability', 'disable_capability')
              and p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('service_role', p.oid, 'execute')),
  2, 'enable_capability and disable_capability are SECURITY DEFINER, executable by authenticated only');
select is(has_column_privilege('authenticated', 'public.capabilities', 'enabled', 'UPDATE'), false,
  'authenticated can no longer update capabilities.enabled');
select is(has_column_privilege('authenticated', 'public.capabilities', 'description', 'UPDATE'), true,
  'authenticated can still update capabilities.description');
select is(has_table_privilege('service_role', 'public.capabilities', 'UPDATE'), false,
  'service_role cannot update capabilities');
select is(private.capability_prerequisite_checks('tasks.manage'), array[]::text[], 'an ungated key needs no checks');

-- 10-15. the owner enables, with every check passing
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'AC1: an owner enables code.run when every required check passed just now');
select is((select enabled from public.capabilities where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'), true, 'AC1: code.run is on');
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'enabling a capability that is already on does nothing');
select lives_ok($$select public.disable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'an owner turns a capability off without any check');
select is((select enabled from public.capabilities where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'), false, 'it is off again');
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'))$$,
  'web.browse (needs all four checks) enables when all four pass');
reset role;

-- 16-27. fail closed: each bad state of one required check refuses (as postgres we change the worker's rows)
update public.capabilities set enabled = false where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse';
update public.capability_prerequisite_status set status = 'fail', reason = 'allowlist_unreadable'
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'egress_default_deny';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'))$$,
  '55000', 'prerequisite check not passing: egress_default_deny', 'AC1: a failing check refuses, and names the check');
select is((select enabled from public.capabilities where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'), false, 'AC1: it stays off');
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'code.run does not need the egress check, so the same failing row does not block it');
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound'))$$,
  '55000', 'prerequisite check not passing: egress_default_deny', 'message.send_outbound needs the egress check');
reset role;

update public.capabilities set enabled = false where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run';
update public.capability_prerequisite_status set status = 'error', reason = 'probe_threw'
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: an errored check refuses');
reset role;

update public.capability_prerequisite_status set status = 'timeout', reason = 'timed_out'
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: a timed out check refuses');
reset role;

update public.capability_prerequisite_status set status = 'not_run', reason = null
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: a check that did not run refuses');
reset role;

-- a pass that is too old is stale
update public.capability_prerequisite_status set status = 'pass', reason = null, checked_at = now() - interval '2 minutes'
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: a stale pass (2 minutes old) refuses');
reset role;

-- a pass dated in the future is refused too (a forged clock cannot keep it fresh)
update public.capability_prerequisite_status set checked_at = now() + interval '1 hour'
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: a pass dated in the future refuses');
reset role;

-- a missing row refuses; a fresh pass enables again
delete from public.capability_prerequisite_status
  where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and check_name = 'sandbox_hardened';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: a missing row refuses (fail closed)');
reset role;
insert into public.capability_prerequisite_status (workspace_id, check_name, status, checked_at)
  values ('85aaaaaa-0000-4000-8000-000000000001', 'sandbox_hardened', 'pass', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'a fresh pass lets code.run enable again');
reset role;

-- an ungated key needs no attestation at all
delete from public.capability_prerequisite_status where workspace_id = '85aaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  'tasks.manage is not gated, so it enables with no attestation');

-- 28-31. the direct route is closed
select throws_ok($$update public.capabilities set enabled = true where key = 'message.send_outbound'$$, '42501', null,
  'AC1: an owner cannot flip enabled directly through the API');
with u as (update public.capabilities set description = 'owner edit' where key = 'vault.read' returning 1)
select is((select count(*)::int from u), 1, 'an owner can still edit a description');
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status)
  values ('85aaaaaa-0000-4000-8000-000000000001', 'sandbox_hardened', 'pass')$$, '42501', null,
  'an owner cannot forge an attestation row');
select throws_ok($$update public.capability_prerequisite_status set status = 'pass'$$, '42501', null, 'nor change one');

-- 32-34. the attestation is readable by members of its workspace only
select is((select count(*)::int from public.capability_prerequisite_status), 0, 'an owner reads their workspace''s attestation (none left here)');
reset role;
insert into public.capability_prerequisite_status (workspace_id, check_name, status, checked_at)
  values ('85aaaaaa-0000-4000-8000-000000000001', 'credential_broker', 'pass', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.capability_prerequisite_status), 1, 'a viewer of A reads A''s attestation');
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.capability_prerequisite_status), 0, 'an owner of B cannot read A''s attestation');

-- 35-38. who may not call it: B's owner, a member, a viewer
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound'))$$,
  '42501', null, 'an owner of another workspace is refused');
select throws_ok($$select public.disable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'and so is their disable');
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'a member is refused');
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'a viewer is refused');

-- 39-43. agents and service callers: no sub means no member
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'AC1: a credential with no user (an agent) is refused');
select throws_ok($$select public.disable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'and cannot disable either');
reset role;
set local role service_role;
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85aaaaaa-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  '42501', null, 'AC1: service_role (the worker role) cannot call enable_capability');
select throws_ok($$update public.capabilities set enabled = true where key = 'message.send_outbound'$$, '42501', null,
  'AC1: nor update capabilities.enabled directly');
reset role;
set local role anon;
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', '85000000-0000-4000-8000-0000000009a9')$$,
  '42501', null, 'anon cannot call enable_capability');
reset role;

-- 44-47. an unknown capability, and the worker role can write its own report
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"85000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', '85000000-0000-4000-8000-0000000009a9')$$,
  'P0002', null, 'a capability id that is not in the workspace is not found');
select throws_ok($$select public.enable_capability('85aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '85bbbbbb-0000-4000-8000-000000000001' and key = 'tasks.manage'))$$,
  'P0002', null, 'another workspace''s capability id is not found either');
reset role;
set local role service_role;
select lives_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status, reason)
  values ('85aaaaaa-0000-4000-8000-000000000001', 'egress_default_deny', 'fail', 'allowlist_unreadable')
  on conflict (workspace_id, check_name) do update set status = excluded.status, reason = excluded.reason, checked_at = now()$$,
  'the worker role (service_role) can record its report');
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status, reason)
  values ('85aaaaaa-0000-4000-8000-000000000001', 'credential_broker', 'fail', 'Error at /srv/app')$$, '23514', null,
  'a free-text reason is rejected by the table');
reset role;

select * from finish();
rollback;
