-- AGO-148 QA: acceptance-criteria tests written independently of agent_credentials.test.sql (the implementer's).
-- Run: pnpm exec supabase test db (inside the db lock). Everything rolls back.
--   AC1  the 15 minute ceiling holds for service_role too, and revoked_at cannot be moved, cleared or reset
--   AC2  service_role cannot issue a credential the agent is not entitled to, and cannot bypass the guard
--   AC3  the issuance log is append-only for service_role, authenticated (owner, member, viewer) and anon;
--        identities are read-only through the API; RLS shows each workspace only its own rows (exact counts,
--        no WHERE clause), and a user in no workspace sees nothing
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

insert into auth.users (id, instance_id, aud, role, email) values
  ('a1480000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148qa-owner@example.test'),
  ('a1480000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148qa-member@example.test'),
  ('a1480000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148qa-viewer@example.test'),
  ('a1480000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148qa-other@example.test'),
  ('a1480000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148qa-nobody@example.test');
insert into public.workspaces (id, name) values
  ('a148aaaa-0000-4000-8000-000000000001', 'AGO-148 QA A'),
  ('a148bbbb-0000-4000-8000-000000000001', 'AGO-148 QA B');
insert into public.members (id, workspace_id, user_id, role) values
  ('a1480000-0000-4000-8000-0000000001a1', 'a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-00000000000a', 'owner'),
  ('a1480000-0000-4000-8000-0000000001a2', 'a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-00000000000c', 'member'),
  ('a1480000-0000-4000-8000-0000000001a3', 'a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-00000000000d', 'viewer'),
  ('a1480000-0000-4000-8000-0000000001b1', 'a148bbbb-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('a1480000-0000-4000-8000-0000000002a1', 'a148aaaa-0000-4000-8000-000000000001', 'QA agent A'),
  ('a1480000-0000-4000-8000-0000000002b1', 'a148bbbb-0000-4000-8000-000000000001', 'QA agent B');
insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values
  ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'vault.read', 0);
insert into public.runs (id, workspace_id, agent_id, status) values
  ('a1480000-0000-4000-8000-0000000003a1', 'a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'running'),
  ('a1480000-0000-4000-8000-0000000003a2', 'a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'running'),
  ('a1480000-0000-4000-8000-0000000003b1', 'a148bbbb-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002b1', 'running');
-- Three credentials in workspace A (one revoked), one in workspace B.
insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at) values
  ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('a', 64), array['vault.read'], now(), now() + interval '10 minutes'),
  ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('b', 64), array[]::text[], now(), now() + interval '10 minutes'),
  ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a2', repeat('d', 64), array['vault.read'], now(), now() + interval '10 minutes'),
  ('a148bbbb-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002b1', 'a1480000-0000-4000-8000-0000000003b1', repeat('c', 64), array[]::text[], now(), now() + interval '10 minutes');
update public.agent_credentials set revoked_at = now() - interval '1 minute' where token_hash = repeat('d', 64);

-- 1-13. service_role: may append and revoke, never edit, delete, empty, or bend the issue rules
set local role service_role;
select throws_ok($$update public.agent_credentials set expires_at = expires_at + interval '5 minutes' where token_hash = repeat('a', 64)$$, '42501', null, 'AC1: service_role cannot extend an expiry');
select throws_ok($$update public.agent_credentials set token_hash = repeat('0', 64) where token_hash = repeat('a', 64)$$, '42501', null, 'AC3: service_role cannot rewrite a token hash');
select throws_ok($$update public.agent_credentials set capabilities = array['vault.read', 'web.search'] where token_hash = repeat('b', 64)$$, '42501', null, 'AC2: service_role cannot widen the capabilities of an issued credential');
select throws_ok($$update public.agent_credentials set revoked_at = now() where token_hash = repeat('d', 64)$$, '42501', null, 'AC1: an already revoked credential cannot be revoked again (revoked_at cannot be moved)');
select throws_ok($$update public.agent_credentials set revoked_at = null where token_hash = repeat('d', 64)$$, '42501', null, 'AC1: a revocation cannot be cleared by service_role');
select throws_ok($$update public.agent_credentials set revoked_at = now(), capabilities = array['vault.read', 'web.search'] where token_hash = repeat('b', 64)$$, '42501', null, 'AC3: revoked_at together with another column is refused');
select throws_ok($$delete from public.agent_credentials$$, '42501', null, 'AC3: service_role cannot delete the whole log');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('e', 64), array['vault.read'], now(), now() + interval '16 minutes')$$,
  '23514', null, 'AC1: service_role cannot issue a 16 minute credential');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('f', 64), array['tasks.manage'], now(), now() + interval '5 minutes')$$,
  '42501', null, 'AC2: service_role cannot issue a capability the agent lacks');
select throws_ok($$set session_replication_role = replica$$, '42501', null, 'AC3: service_role cannot switch to replica mode to skip the guard triggers');
select throws_ok($$update public.agent_identities set agent_id = agent_id$$, '42501', null, 'service_role cannot edit an identity');
select throws_ok($$delete from public.agent_identities$$, '42501', null, 'service_role cannot delete an identity');
select throws_ok($$truncate public.agent_identities$$, '42501', null, 'service_role cannot empty the identities');
reset role;

-- 14-23. authenticated (owner, member, viewer) and anon: no write of any kind
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$update public.agent_credentials set revoked_at = now() where token_hash = repeat('a', 64)$$, '42501', null, 'AC3: an owner cannot revoke through the API (the worker does)');
select throws_ok($$delete from public.agent_credentials where token_hash = repeat('a', 64)$$, '42501', null, 'AC3: an owner cannot delete an issuance row');
select throws_ok($$update public.agent_identities set agent_id = agent_id$$, '42501', null, 'an owner cannot edit an identity');
select throws_ok($$delete from public.agent_identities$$, '42501', null, 'an owner cannot delete an identity');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, expires_at)
  values ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('9', 64), array[]::text[], now() + interval '5 minutes')$$,
  '42501', null, 'AC2: a member cannot issue a credential through the API');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$update public.agent_credentials set revoked_at = now() where token_hash = repeat('a', 64)$$, '42501', null, 'AC3: a viewer cannot revoke');
reset role;
set local role anon;
select throws_ok($$update public.agent_credentials set revoked_at = now()$$, '42501', null, 'AC3: anon cannot update the log');
select throws_ok($$delete from public.agent_credentials$$, '42501', null, 'AC3: anon cannot delete from the log');
select throws_ok($$select 1 from public.agent_identities$$, '42501', null, 'anon cannot read identities');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, expires_at)
  values ('a148aaaa-0000-4000-8000-000000000001', 'a1480000-0000-4000-8000-0000000002a1', 'a1480000-0000-4000-8000-0000000003a1', repeat('8', 64), array[]::text[], now() + interval '5 minutes')$$,
  '42501', null, 'AC2: anon cannot issue a credential');
reset role;

-- 24-31. RLS read scope: exact counts with no WHERE clause, so a leak shows up as a wrong number
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials), 3, 'AC3: an owner of workspace A reads exactly its 3 credentials');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials), 3, 'AC3: a member of workspace A reads exactly its 3 credentials');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials), 3, 'AC3: a viewer of workspace A reads exactly its 3 credentials');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials), 1, 'AC3: the owner of workspace B reads exactly its 1 credential');
select is((select count(*)::int from public.agent_credentials where workspace_id <> 'a148bbbb-0000-4000-8000-000000000001'), 0, 'AC3: none of workspace A''s credentials are visible to workspace B');
select is((select count(*)::int from public.agent_identities), 1, 'workspace B reads exactly its 1 identity');
select set_config('request.jwt.claims', '{"sub":"a1480000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials), 0, 'AC3: a user in no workspace reads no credentials');
select is((select count(*)::int from public.agent_identities), 0, 'a user in no workspace reads no identities');
reset role;

-- 32-33. after every attempt above, the log is exactly as written
select is((select capabilities from public.agent_credentials where token_hash = repeat('b', 64)), array[]::text[], 'AC3: nothing above changed an issued credential');
select throws_ok($$update public.agent_credentials set workspace_id = 'a148bbbb-0000-4000-8000-000000000001' where token_hash = repeat('a', 64)$$, '42501', null, 'AC3: even the owner cannot move an issuance row to another workspace');

select * from finish();
rollback;
