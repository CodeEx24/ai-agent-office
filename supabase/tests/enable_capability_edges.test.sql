-- AGO-85 (functional tester, round 2): edge cases that enable_capability.test.sql does not pin.
--   AC1  cross-workspace attestation, freshness and clock-skew boundaries, a full pass for every gated key,
--        disable_capability not-found paths, attestation table constraints and read access, and the direct-update
--        route when the request tries to smuggle `enabled` next to an allowed column.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, instance_id, aud, role, email) values
  ('86000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85e-a@example.test'),
  ('86000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago85e-b@example.test');
insert into public.workspaces (id, name) values
  ('86aaaaaa-0000-4000-8000-000000000001', 'AGO-85 edges A'),
  ('86bbbbbb-0000-4000-8000-000000000001', 'AGO-85 edges B');
insert into public.members (id, workspace_id, user_id, role) values
  ('86000000-0000-4000-8000-0000000001a1', '86aaaaaa-0000-4000-8000-000000000001', '86000000-0000-4000-8000-00000000000a', 'owner'),
  ('86000000-0000-4000-8000-0000000001b1', '86bbbbbb-0000-4000-8000-000000000001', '86000000-0000-4000-8000-00000000000b', 'owner');

create temp table t_cap as
  select workspace_id, key, id from public.capabilities
   where workspace_id in ('86aaaaaa-0000-4000-8000-000000000001', '86bbbbbb-0000-4000-8000-000000000001');
grant select on t_cap to authenticated, anon, service_role;
update public.capabilities set enabled = false
  where workspace_id in ('86aaaaaa-0000-4000-8000-000000000001', '86bbbbbb-0000-4000-8000-000000000001')
    and key in ('code.run', 'web.browse', 'message.send_outbound');
-- only workspace A has a worker report: everything passes, just now
insert into public.capability_prerequisite_status (workspace_id, check_name, status, checked_at)
select '86aaaaaa-0000-4000-8000-000000000001', n, 'pass', now()
  from unnest(array['sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash']) as n;

-- 1-3. cross-workspace: A's passing report cannot enable B's capability
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('86bbbbbb-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86bbbbbb-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', 'prerequisite check not passing: sandbox_hardened', 'AC1: another workspace''s passing report does not count (B has no attestation)');
select is((select enabled from public.capabilities where workspace_id = '86bbbbbb-0000-4000-8000-000000000001' and key = 'code.run'), false,
  'AC1: B''s code.run stays off');
select throws_ok($$select public.enable_capability('86bbbbbb-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'P0002', null, 'AC1: B''s owner cannot enable A''s capability id by naming their own workspace');
reset role;

-- 4-7. every gated key enables with a full pass
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'AC1: code.run enables with a full pass');
select lives_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound'))$$,
  'AC1: message.send_outbound enables with a full pass');
select is((select count(*)::int from public.capabilities where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key in ('code.run', 'message.send_outbound') and enabled), 2,
  'AC1: both are on');
select lives_ok($$select public.disable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound'))$$,
  'a disable needs no attestation');
reset role;
update public.capabilities set enabled = false where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run';

-- 8. freshness boundary: 50 s old is fresh
update public.capability_prerequisite_status set checked_at = now() - interval '50 seconds'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'AC1: a pass 50 seconds old (inside the 60 s window) still enables');
reset role;

-- 9-10. 70 s old is stale (a stopped worker)
update public.capabilities set enabled = false where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run';
update public.capability_prerequisite_status set checked_at = now() - interval '70 seconds'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', null, 'AC1: when every report is 70 seconds old (a stopped worker), enabling is refused');
select is((select enabled from public.capabilities where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'), false,
  'AC1: and the capability stays off');
reset role;

-- 11. clock skew: 3 s ahead is tolerated
update public.capability_prerequisite_status set checked_at = now() + interval '3 seconds'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'a report dated 3 seconds ahead (small clock skew) is tolerated');
reset role;

-- 12. 30 s ahead is refused
update public.capabilities set enabled = false where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run';
update public.capability_prerequisite_status set checked_at = now() + interval '30 seconds'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  '55000', null, 'AC1: a report dated 30 seconds ahead is refused');
reset role;

-- 13-14. one failing check among fresh passing ones refuses
update public.capability_prerequisite_status set status = 'pass', checked_at = now()
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
update public.capability_prerequisite_status set status = 'fail', reason = 'hook_missing'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and check_name = 'approval_payload_hash';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound'))$$,
  '55000', 'prerequisite check not passing: approval_payload_hash', 'AC1: one failing check among passing ones refuses message.send_outbound');
select throws_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'))$$,
  '55000', 'prerequisite check not passing: approval_payload_hash', 'AC1: and web.browse');

-- 15-17. disable not-found paths and idempotence
select throws_ok($$select public.disable_capability('86aaaaaa-0000-4000-8000-000000000001', '86000000-0000-4000-8000-0000000009a9')$$,
  'P0002', null, 'disabling an unknown capability id is not found');
select throws_ok($$select public.disable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86bbbbbb-0000-4000-8000-000000000001' and key = 'code.run'))$$,
  'P0002', null, 'disabling another workspace''s capability is not found');
select lives_ok($$select public.disable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'))$$,
  'disabling a capability that is already off does nothing');

-- 18-19. direct route: enabled next to the still-editable description
select throws_ok($$update public.capabilities set description = 'x', enabled = true where key = 'web.browse'$$, '42501', null,
  'AC1: setting enabled together with description is refused');
select is((select enabled from public.capabilities where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'), false,
  'AC1: nothing changed');
reset role;

-- 20-24. table constraints (as the worker role)
set local role service_role;
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status)
  values ('86aaaaaa-0000-4000-8000-000000000001', 'made_up_check', 'pass')$$, '23514', null, 'an unknown check name is rejected by the table');
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status)
  values ('86bbbbbb-0000-4000-8000-000000000001', 'sandbox_hardened', 'ok')$$, '23514', null, 'an unknown status is rejected by the table');
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status)
  values ('86aaaaaa-0000-4000-8000-000000000001', 'sandbox_hardened', 'pass')$$, '23505', null, 'a second row for the same workspace and check is rejected');
select throws_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status)
  values ('86000000-0000-4000-8000-0000000009a9', 'sandbox_hardened', 'pass')$$, '23503', null, 'a report for a workspace that does not exist is rejected');
select throws_ok($$delete from public.capability_prerequisite_status$$, '42501', null, 'the worker role cannot delete reports');
reset role;

-- 25-27. read and delete access
set local role anon;
select throws_ok($$select count(*) from public.capability_prerequisite_status$$, '42501', null, 'anon cannot read the attestation table');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$delete from public.capability_prerequisite_status$$, '42501', null, 'a signed-in owner cannot delete reports');
select is((select count(*)::int from public.capability_prerequisite_status where workspace_id = '86aaaaaa-0000-4000-8000-000000000001'), 0,
  'a signed-in user of another workspace reads none of A''s reports');
reset role;

-- 28-29. the worker's upsert flips stale rows back to fresh, and enabling works again
update public.capability_prerequisite_status set status = 'pass', reason = null, checked_at = now() - interval '5 minutes'
  where workspace_id = '86aaaaaa-0000-4000-8000-000000000001';
set local role service_role;
select lives_ok($$insert into public.capability_prerequisite_status (workspace_id, check_name, status, reason, checked_at)
  select w.id, n, 'pass', null, now() from public.workspaces w, unnest(array['sandbox_hardened', 'egress_default_deny', 'credential_broker', 'approval_payload_hash']) n
   where w.id = '86aaaaaa-0000-4000-8000-000000000001'
  on conflict (workspace_id, check_name) do update set status = excluded.status, reason = excluded.reason, checked_at = excluded.checked_at$$,
  'the worker''s upsert refreshes every row');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"86000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.enable_capability('86aaaaaa-0000-4000-8000-000000000001', (select id from t_cap where workspace_id = '86aaaaaa-0000-4000-8000-000000000001' and key = 'web.browse'))$$,
  'AC1: after the worker refreshes its report, enabling works again');
reset role;

select * from finish();
rollback;
