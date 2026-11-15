-- AGO-99: new agents start in Strict; only a workspace owner promotes or demotes one; every change is logged (pgTAP).
--   shape: agent_mode_changes has workspace_id, RLS on, no INSERT/UPDATE/DELETE/TRUNCATE grant for any API role;
--     set_agent_mode is SECURITY DEFINER, executable by authenticated only (not anon, not service_role)
--   AC1 default: an agent row starts in strict; a row cannot be inserted in another mode (even by the table owner)
--   AC2 human-only and logged: owners change a mode (any mode to any other) and one log row is written with the
--     caller's own member id; members, viewers, non-members, signed-out callers (no auth.uid(), which is every agent
--     credential) and service_role are refused and leave no row; no other path changes a mode without an owner and a
--     log row (API update, service_role, table owner, a forged session flag); both triggers are ENABLE ALWAYS
--   rules: unknown mode, same mode, unknown or foreign agent and archived agent are refused with their own error codes
--   log: append-only (UPDATE, DELETE, TRUNCATE refused for the table owner and every API role); members and viewers of
--     the workspace read it, another workspace reads none; deleting an agent removes its log rows
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

insert into auth.users (id, instance_id, aud, role, email) values
  ('99100000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99-o@example.test'),
  ('99100000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99-m@example.test'),
  ('99100000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99-v@example.test'),
  ('99100000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99-b@example.test');
insert into public.workspaces (id, name) values
  ('99aaaaaa-0000-4000-8000-000000000001', 'AGO-99 A'),
  ('99bbbbbb-0000-4000-8000-000000000001', 'AGO-99 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('99100000-0000-4000-8000-0000000001a1', '99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-00000000000a', 'owner'),
  ('99100000-0000-4000-8000-0000000001a2', '99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-00000000000c', 'member'),
  ('99100000-0000-4000-8000-0000000001a3', '99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-00000000000d', 'viewer'),
  ('99100000-0000-4000-8000-0000000001b1', '99bbbbbb-0000-4000-8000-000000000001', '99100000-0000-4000-8000-00000000000b', 'owner');
-- no mode given: the column default decides (AC1). a1 = promoted and demoted, a2 = deleted later, a3 = archived,
-- b1 = the other workspace's agent
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents) values
  ('99100000-0000-4000-8000-0000000002a1', '99aaaaaa-0000-4000-8000-000000000001', 'Alpha', 'R', 'claude-haiku-5-5', 'p', 100),
  ('99100000-0000-4000-8000-0000000002a2', '99aaaaaa-0000-4000-8000-000000000001', 'Beta', 'R', 'claude-haiku-5-5', 'p', 100),
  ('99100000-0000-4000-8000-0000000002a3', '99aaaaaa-0000-4000-8000-000000000001', 'Gamma', 'R', 'claude-haiku-5-5', 'p', 100),
  ('99100000-0000-4000-8000-0000000002b1', '99bbbbbb-0000-4000-8000-000000000001', 'B agent', 'R', 'claude-haiku-5-5', 'p', 100);

-- 1. Shape and privileges.
select has_table('public', 'agent_mode_changes', 'agent_mode_changes exists');
select col_not_null('public', 'agent_mode_changes', 'workspace_id', 'agent_mode_changes carries workspace_id');
select is((select relrowsecurity from pg_class where oid = 'public.agent_mode_changes'::regclass), true, 'RLS is on');
select is((select count(*)::int from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'agent_mode_changes'
              and grantee in ('anon', 'authenticated', 'service_role', 'public')
              and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no API role holds INSERT, UPDATE, DELETE or TRUNCATE on agent_mode_changes');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'set_agent_mode'
              and p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('service_role', p.oid, 'execute')),
  1, 'set_agent_mode is SECURITY DEFINER, executable by authenticated only');
select is((select count(*)::int from pg_constraint where conrelid = 'public.agents'::regclass and conname = 'agents_mode_check'),
  1, 'agents.mode has its allow-list CHECK');

-- 2. AC1: the default is strict, and nothing can be born in another mode.
select is((select mode from public.agents where id = '99100000-0000-4000-8000-0000000002a1'), 'strict', 'AC1: an agent inserted without a mode is Strict');
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('99aaaaaa-0000-4000-8000-000000000001', 'Born loose', 'relaxed')$$,
  '42501', null, 'AC1: even the table owner cannot insert an agent in another mode');
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('99aaaaaa-0000-4000-8000-000000000001', 'Born odd', 'permissive')$$,
  null, null, 'AC1: a mode outside the list is refused');

-- 3. AC2: an owner promotes; one log row with the caller's own member id.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'standard')$$,
  'AC2: an owner promotes Strict to Standard');
select is((select mode from public.agents where id = '99100000-0000-4000-8000-0000000002a1'), 'standard', 'the mode is now Standard');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'), 1, 'one log row was written');
select is((select from_mode || '>' || to_mode from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'),
  'strict>standard', 'the row records from and to');
select is((select changed_by from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'),
  '99100000-0000-4000-8000-0000000001a1'::uuid, 'the row records the caller''s own member id');
select is((select count(*)::int from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
            and proname in ('set_agent_mode', 'agents_log_mode_change', 'agents_guard_mode')
            and pg_get_functiondef(oid) like '%ago.mode_change%'),
  0, 'no function relies on a session flag any more');

-- 4. Any mode to any other: Standard to Relaxed, Relaxed back to Strict.
select lives_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  'Standard to Relaxed');
select lives_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'strict')$$,
  'a demotion back to Strict is allowed too');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'), 3, 'every change was logged (3 rows)');
select is((select mode from public.agents where id = '99100000-0000-4000-8000-0000000002a1'), 'strict', 'the agent ended in Strict');

-- 5. Rules: same mode, unknown mode, unknown agent, another workspace's agent.
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'strict')$$,
  'AGM01', null, 'the same mode is refused');
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'permissive')$$,
  '22023', null, 'a mode outside the list is refused');
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', null)$$,
  '22023', null, 'a null mode is refused');
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-00000000ffff', 'standard')$$,
  'P0002', null, 'an unknown agent is refused');
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002b1', 'standard')$$,
  'P0002', null, 'another workspace''s agent is refused');
select lives_ok($$select public.archive_agent('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a3')$$, 'setup: an owner archives Gamma');
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a3', 'standard')$$,
  '55000', null, 'an archived agent cannot change mode');

-- 6. Nobody else can change a mode, and a refusal leaves no row.
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: a member cannot change a mode');
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: a viewer cannot change a mode');
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: the owner of another workspace cannot change it');
-- an agent credential is not a signed-in user: no auth.uid(), so no member
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: a caller with no user (an agent credential) cannot change a mode');
reset role;
set local role anon;
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: a signed-out caller cannot call it');
reset role;
set local role service_role;
select throws_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  '42501', null, 'AC2: service_role cannot call it');
reset role;
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'), 3, 'the refusals left no log row');
select is((select mode from public.agents where id = '99100000-0000-4000-8000-0000000002a1'), 'strict', 'and the mode did not move');

-- 7. No other path changes a mode: not the API, not the table owner.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  '42501', null, 'AC2: an owner cannot update agents.mode directly');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  '42501', null, 'AC2: the table owner with no signed-in user cannot change a mode');
select lives_ok($$update public.agents set name = 'Alpha 2' where id = '99100000-0000-4000-8000-0000000002a1'$$, 'other columns are not affected by the guard');

-- 8. The log: members and viewers read it; another workspace reads none; nobody writes it.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_mode_changes), 3, 'a viewer reads the workspace''s log');
select throws_ok($$insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by) values ('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a1', 'strict', 'relaxed', '99100000-0000-4000-8000-0000000001a1')$$,
  '42501', null, 'nobody can write the log directly');
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_mode_changes), 0, 'another workspace reads none of it');
reset role;

-- 9. Append-only for the table owner too, and deleting an agent removes its rows.
select throws_ok($$update public.agent_mode_changes set to_mode = 'relaxed'$$, '42501', null, 'UPDATE is refused for the table owner');
select throws_ok($$delete from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'$$, '42501', null, 'DELETE is refused for the table owner');
select throws_ok($$truncate public.agent_mode_changes$$, '42501', null, 'TRUNCATE is refused for the table owner');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.set_agent_mode('99aaaaaa-0000-4000-8000-000000000001', '99100000-0000-4000-8000-0000000002a2', 'standard')$$, 'setup: Beta gets a log row');
reset role;
select lives_ok($$delete from public.agents where id = '99100000-0000-4000-8000-0000000002a2'$$, 'an agent can be deleted');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a2'), 0, 'its log rows went with it');

-- 10. No forged flag, no unlogged path: a direct UPDATE of agents.mode needs a signed-in owner and writes the log row.
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from pg_trigger where tgrelid = 'public.agents'::regclass
            and tgname in ('agents_guard_mode_insert', 'agents_log_mode_change') and tgenabled = 'A'),
  2, 'the insert guard and the log trigger are ENABLE ALWAYS');
select set_config('ago.mode_change', 'on', true); -- the old session flag: it must not open anything
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  '42501', 'an agent mode can only be changed by a signed-in owner of the workspace', 'table owner with the old flag set: refused');
set local role service_role;
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  '42501', null, 'service_role with the old flag set: refused (here already by a privilege wall on agents, whichever stops it first)');
reset role;
select is((select mode from public.agents where id = '99100000-0000-4000-8000-0000000002a1'), 'strict', 'the refused direct updates left the mode alone');
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  '42501', 'an agent mode can only be changed by a signed-in owner of the workspace', 'a direct update in a member session: refused');
select set_config('request.jwt.claims', '{"sub":"99100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$update public.agents set mode = 'relaxed' where id = '99100000-0000-4000-8000-0000000002a1'$$,
  'a direct update in an owner session goes through ...');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1' and from_mode = 'strict' and to_mode = 'relaxed'
            and changed_by = '99100000-0000-4000-8000-0000000001a1'),
  1, '... and writes a log row with that owner as the actor');
select lives_ok($$update public.agents set mode = mode where id = '99100000-0000-4000-8000-0000000002a1'$$, 'an update that keeps the mode is not a change');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99100000-0000-4000-8000-0000000002a1'), 4, 'and writes no log row');

select * from finish();
rollback;
