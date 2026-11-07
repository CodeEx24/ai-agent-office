-- AGO-148: per-agent identity and short-lived scoped credentials.
--   AC1  a credential lives at most 15 minutes and cannot be issued for a run that has ended; it is revoked at run end
--   AC2  a credential cannot carry a capability the agent lacks (not granted, disabled, or not in the catalog)
--   AC3  every issuance is logged: append-only for every role, members read their own workspace's log only
-- The AGO-107 catalog test (rls_catalog.test.sql) and the role matrix (rls_every_table.test.sql) also cover the
-- new tables' RLS, grants and pinned search_path automatically.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

insert into auth.users (id, instance_id, aud, role, email) values
  ('14800000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148-a@example.test'),
  ('14800000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148-b@example.test'),
  ('14800000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago148-v@example.test');
insert into public.workspaces (id, name) values
  ('148aaaaa-0000-4000-8000-000000000001', 'AGO-148 A'),
  ('148bbbbb-0000-4000-8000-000000000001', 'AGO-148 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('14800000-0000-4000-8000-0000000001a1', '148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-00000000000a', 'owner'),
  ('14800000-0000-4000-8000-0000000001a3', '148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-00000000000d', 'viewer'),
  ('14800000-0000-4000-8000-0000000001b1', '148bbbbb-0000-4000-8000-000000000001', '14800000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('14800000-0000-4000-8000-0000000002a1', '148aaaaa-0000-4000-8000-000000000001', 'Agent A'),
  ('14800000-0000-4000-8000-0000000002b1', '148bbbbb-0000-4000-8000-000000000001', 'Agent B');
-- Agent A holds vault.read and web.search; it does not hold tasks.manage.
insert into public.agent_capabilities (workspace_id, agent_id, capability, tier) values
  ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', 'vault.read', 0),
  ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', 'web.search', 1);
insert into public.runs (id, workspace_id, agent_id, status) values
  ('14800000-0000-4000-8000-0000000003a1', '148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', 'running'),
  ('14800000-0000-4000-8000-0000000003a2', '148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', 'running'),
  ('14800000-0000-4000-8000-0000000003b1', '148bbbbb-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002b1', 'running');

-- 1-5. identities
select has_table('public', 'agent_credentials', 'public.agent_credentials exists');
select has_table('public', 'agent_identities', 'public.agent_identities exists');
select is((select count(*)::int from public.agent_identities where agent_id = '14800000-0000-4000-8000-0000000002a1'), 1,
  'each agent has exactly one identity');
insert into public.agents (id, workspace_id, name) values ('14800000-0000-4000-8000-0000000002a9', '148aaaaa-0000-4000-8000-000000000001', 'Agent A2');
select is((select count(*)::int from public.agent_identities where agent_id = '14800000-0000-4000-8000-0000000002a9'), 1,
  'a new agent gets its identity automatically');
select is((select count(*)::int from auth.users u join public.agent_identities i on i.id = u.id), 0,
  'an agent identity is never an auth user (non-login principal)');

-- 6-16. AC1 + AC2: what can be issued
select lives_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('a', 64), array['vault.read', 'web.search'], now(), now() + interval '15 minutes')$$,
  'AC1: a 15 minute credential with granted capabilities is issued');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('b', 64), array['vault.read'], now(), now() + interval '16 minutes')$$,
  '23514', null, 'AC1: a credential longer than 15 minutes is rejected by the database');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('c', 64), array['vault.read'], now(), now() - interval '1 minute')$$,
  '23514', null, 'AC1: a credential that expires before it is issued is rejected');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('d', 64), array['vault.read', 'tasks.manage'], now(), now() + interval '5 minutes')$$,
  '42501', null, 'AC2: a capability the agent was not granted cannot be put on a credential');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('e', 64), array['nope.nothing'], now(), now() + interval '5 minutes')$$,
  '42501', null, 'AC2: a capability that is not in the catalog cannot be put on a credential');
update public.capabilities set enabled = false
  where workspace_id = '148aaaaa-0000-4000-8000-000000000001' and key = 'web.search';
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('f', 64), array['web.search'], now(), now() + interval '5 minutes')$$,
  '42501', null, 'AC2: a granted capability the workspace has disabled cannot be put on a credential');
update public.capabilities set enabled = true
  where workspace_id = '148aaaaa-0000-4000-8000-000000000001' and key = 'web.search';
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002b1', '14800000-0000-4000-8000-0000000003a1',
          repeat('1', 64), array[]::text[], now(), now() + interval '5 minutes')$$,
  '42501', null, 'a credential for a run that belongs to another agent is rejected');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003b1',
          repeat('2', 64), array[]::text[], now(), now() + interval '5 minutes')$$,
  '42501', null, 'a credential for another workspace''s run is rejected');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('3', 64), array[]::text[], now() - interval '5 minutes', now() + interval '5 minutes')$$,
  '42501', null, 'a back-dated issued_at (more than 30 seconds from the database clock) is rejected');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          'not-a-hash', array[]::text[], now(), now() + interval '5 minutes')$$,
  '23514', null, 'only a sha256 hex digest is accepted as the token hash (a raw token cannot be stored)');

-- 17-18. a forged revoked_at is cleared; the token hash is unique
insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at, revoked_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a2',
          repeat('4', 64), array['vault.read'], now(), now() + interval '5 minutes', now());
select is((select revoked_at from public.agent_credentials where token_hash = repeat('4', 64)), null,
  'a credential cannot be issued pre-revoked by the caller: revoked_at starts null');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a2',
          repeat('4', 64), array[]::text[], now(), now() + interval '5 minutes')$$,
  '23505', null, 'a token hash is unique');

-- 19-26. AC3: append-only. Only revoked_at null -> timestamp is allowed, once.
select lives_ok($$update public.agent_credentials set revoked_at = now() where token_hash = repeat('4', 64)$$,
  'revoked_at can be set once');
select throws_ok($$update public.agent_credentials set revoked_at = null where token_hash = repeat('4', 64)$$, '42501', null,
  'AC3: a revocation cannot be undone');
select throws_ok($$update public.agent_credentials set capabilities = array['vault.read', 'web.search'] where token_hash = repeat('a', 64)$$,
  '42501', null, 'AC3: the capability set of an issued credential cannot be edited');
select throws_ok($$update public.agent_credentials set expires_at = expires_at + interval '1 hour' where token_hash = repeat('a', 64)$$,
  '42501', null, 'AC1: the expiry of an issued credential cannot be extended');
select throws_ok($$delete from public.agent_credentials where token_hash = repeat('a', 64)$$, '42501', null,
  'AC3: an issuance row cannot be deleted by the table owner');
select throws_ok($$truncate public.agent_credentials$$, '42501', null, 'AC3: the log cannot be emptied by the table owner (bulk TRUNCATE)');
select throws_ok($$truncate public.agents cascade$$, '42501', null, 'AC3: a TRUNCATE ... CASCADE from agents cannot empty the log either');
select is((select count(*)::int from pg_trigger
  where tgrelid in ('public.agent_credentials'::regclass) and tgenabled = 'A'
    and tgname in ('agent_credentials_block_update', 'agent_credentials_block_delete', 'agent_credentials_block_truncate', 'check_agent_credential_issue')),
  4, 'the guard triggers are ENABLE ALWAYS (they also fire under session_replication_role = replica)');

-- 27-32. every role: service_role, authenticated, anon
set local role service_role;
select throws_ok($$update public.agent_credentials set capabilities = '{}' where token_hash = repeat('a', 64)$$, '42501', null, 'service_role cannot edit an issuance row');
select throws_ok($$delete from public.agent_credentials where token_hash = repeat('a', 64)$$, '42501', null, 'service_role cannot delete an issuance row');
select throws_ok($$truncate public.agent_credentials$$, '42501', null, 'service_role cannot empty the log');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"14800000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('9', 64), array[]::text[], now() + interval '5 minutes')$$,
  '42501', null, 'an owner cannot issue a credential through the API (no INSERT grant)');
select throws_ok($$insert into public.agent_identities (workspace_id, agent_id) values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a9')$$,
  '42501', null, 'an owner cannot write an identity through the API');
select throws_ok($$truncate public.agent_credentials$$, '42501', null, 'authenticated cannot empty the log');
reset role;
set local role anon;
select throws_ok($$select 1 from public.agent_credentials$$, '42501', null, 'anon cannot read the log');
reset role;

-- 33-37. RLS: members and viewers read their own workspace; nothing leaks across workspaces
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"14800000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select cmp_ok((select count(*)::int from public.agent_credentials), '>=', 2, 'AC3: an owner reads the issuance log of their workspace');
select is((select count(*)::int from public.agent_identities), 2, 'an owner reads the identities of their workspace (agents A and A2)');
select set_config('request.jwt.claims', '{"sub":"14800000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select cmp_ok((select count(*)::int from public.agent_credentials), '>=', 2, 'a viewer reads the issuance log of their workspace');
select set_config('request.jwt.claims', '{"sub":"14800000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_credentials where workspace_id = '148aaaaa-0000-4000-8000-000000000001'), 0,
  'another workspace''s owner sees none of workspace A''s credentials');
select is((select count(*)::int from public.agent_identities where workspace_id = '148aaaaa-0000-4000-8000-000000000001'), 0,
  'another workspace''s owner sees none of workspace A''s identities');
reset role;

-- 38-39. service_role may append and revoke (the worker path), nothing else
set local role service_role;
select lives_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148bbbbb-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002b1', '14800000-0000-4000-8000-0000000003b1',
          repeat('5', 64), array[]::text[], now(), now() + interval '5 minutes')$$, 'service_role can append a credential');
select lives_ok($$update public.agent_credentials set revoked_at = now() where token_hash = repeat('5', 64)$$, 'service_role can set revoked_at');
reset role;

-- 40-42. AC1: a credential is revoked when the run ends, and none can be issued afterwards
update public.runs set status = 'succeeded' where id = '14800000-0000-4000-8000-0000000003a1';
select is((select count(*)::int from public.agent_credentials where run_id = '14800000-0000-4000-8000-0000000003a1' and revoked_at is null), 0,
  'AC1: every credential of a run is revoked when the run ends');
select throws_ok($$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at)
  values ('148aaaaa-0000-4000-8000-000000000001', '14800000-0000-4000-8000-0000000002a1', '14800000-0000-4000-8000-0000000003a1',
          repeat('6', 64), array[]::text[], now(), now() + interval '5 minutes')$$,
  '42501', null, 'AC1: no credential can be issued for a run that has ended');
select is((select count(*)::int from public.agent_credentials where run_id = '14800000-0000-4000-8000-0000000003a2' and revoked_at is not null), 1,
  'a run that is still running keeps its own revocation state');

-- 43-45. history is kept: an agent with credentials cannot be deleted; a whole workspace still can
select throws_ok($$delete from public.agents where id = '14800000-0000-4000-8000-0000000002a1'$$, '23503', null,
  'an agent that has issued credentials cannot be deleted (history is kept)');
select lives_ok($$delete from public.agents where id = '14800000-0000-4000-8000-0000000002a9'$$, 'an agent without history is deleted, and its identity with it');
select lives_ok($$delete from public.workspaces where id = '148bbbbb-0000-4000-8000-000000000001'$$,
  'deleting a whole workspace still cascades through the issuance log');

-- 46-47. grants
select is((select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['agent_credentials', 'agent_identities']) t
  where has_table_privilege(r, 'public.' || t, 'DELETE,TRUNCATE,TRIGGER,REFERENCES')),
  0, 'no API role holds DELETE, TRUNCATE, TRIGGER or REFERENCES on either table');
select is((select count(*)::int from unnest(array['anon', 'authenticated']) r,
    unnest(array['agent_credentials', 'agent_identities']) t
  where has_any_column_privilege(r, 'public.' || t, 'INSERT,UPDATE')),
  0, 'anon and authenticated hold no INSERT or UPDATE on either table');

select * from finish();
rollback;
