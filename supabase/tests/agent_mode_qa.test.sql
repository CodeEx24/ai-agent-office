-- AGO-99 functional QA (pgTAP): edge cases that supabase/tests/agent_mode.test.sql does not cover.
--   AC1 default: a duplicate of a promoted agent still starts in Strict and writes no log row; a NULL mode and a
--     service_role insert in another mode are refused; an explicit 'strict' insert is accepted
--   AC2 human-only: a direct update (owner, service_role) cannot demote or promote; an update that does not change the
--     mode passes the guard; wrong-workspace calls by an owner are refused with the right code
--   AC2 logged: a second owner is recorded under their own member id; from/to chain is exact across several changes;
--     every kind of refusal (same mode, bad mode spelling, unknown agent, archived agent, foreign workspace) leaves
--     the log untouched; unarchiving lets the change through and it is logged; anon cannot read the log
--   log table: CHECK and FK still hold for the table owner (same mode, bogus mode, member of another workspace)
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

insert into auth.users (id, instance_id, aud, role, email) values
  ('99200000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99q-o1@example.test'),
  ('99200000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99q-o2@example.test'),
  ('99200000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago99q-b@example.test');
insert into public.workspaces (id, name) values
  ('99caaaaa-0000-4000-8000-000000000001', 'AGO-99 QA A'),
  ('99cbbbbb-0000-4000-8000-000000000001', 'AGO-99 QA B');
insert into public.members (id, workspace_id, user_id, role) values
  ('99200000-0000-4000-8000-0000000001a1', '99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-00000000000a', 'owner'),
  ('99200000-0000-4000-8000-0000000001a2', '99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-00000000000e', 'owner'),
  ('99200000-0000-4000-8000-0000000001b1', '99cbbbbb-0000-4000-8000-000000000001', '99200000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents) values
  ('99200000-0000-4000-8000-0000000002a1', '99caaaaa-0000-4000-8000-000000000001', 'Alpha', 'R', 'claude-haiku-5-5', 'p', 100),
  ('99200000-0000-4000-8000-0000000002a3', '99caaaaa-0000-4000-8000-000000000001', 'Gamma', 'R', 'claude-haiku-5-5', 'p', 100),
  ('99200000-0000-4000-8000-0000000002b1', '99cbbbbb-0000-4000-8000-000000000001', 'B agent', 'R', 'claude-haiku-5-5', 'p', 100);

-- 1. AC1: a copy of a promoted agent is Strict and is not a "mode change".
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99200000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'relaxed')$$,
  'setup: an owner promotes Alpha to Relaxed');
create temp table t_copy as
  select public.duplicate_agent('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'Alpha copy') as id;
grant select on t_copy to authenticated;
select is((select mode from public.agents where id = (select id from t_copy)), 'strict', 'AC1: a duplicate of a Relaxed agent starts in Strict');
select is((select mode from public.agents where id = '99200000-0000-4000-8000-0000000002a1'), 'relaxed', 'the source agent keeps its own mode');
select is((select count(*)::int from public.agent_mode_changes where agent_id = (select id from t_copy)), 0, 'creating the copy wrote no mode change row');
reset role;

-- 2. AC1: direct inserts.
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('99caaaaa-0000-4000-8000-000000000001', 'Born null', null)$$,
  '23502', null, 'AC1: a NULL mode is refused (no way to dodge the default with NULL)');
set local role service_role;
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('99caaaaa-0000-4000-8000-000000000001', 'Born by service', 'standard')$$,
  '42501', null, 'AC1: service_role cannot insert an agent in another mode');
reset role;
select lives_ok($$insert into public.agents (workspace_id, name, mode) values ('99caaaaa-0000-4000-8000-000000000001', 'Born strict', 'strict')$$,
  'AC1: an explicit strict insert is accepted');
select is((select mode from public.agents where name = 'Born strict'), 'strict', 'and it is Strict');

-- 3. AC2: a second owner is logged under their own member id; the chain of changes is exact.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99200000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
select lives_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'strict')$$,
  'a second owner demotes Alpha back to Strict');
select is((select changed_by from public.agent_mode_changes where agent_id = '99200000-0000-4000-8000-0000000002a1' and to_mode = 'strict'),
  '99200000-0000-4000-8000-0000000001a2'::uuid, 'the demotion is recorded under the second owner''s member id');
select is((select changed_by from public.agent_mode_changes where agent_id = '99200000-0000-4000-8000-0000000002a1' and to_mode = 'relaxed'),
  '99200000-0000-4000-8000-0000000001a1'::uuid, 'the promotion is still recorded under the first owner''s member id');
select is((select array_agg(from_mode || '>' || to_mode order by from_mode) from public.agent_mode_changes where agent_id = '99200000-0000-4000-8000-0000000002a1'),
  array['relaxed>strict', 'strict>relaxed'], 'from and to form the exact chain of changes');

-- 4. AC2: every refusal leaves the log untouched.
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'strict')$$,
  'AGM01', null, 'the same mode is refused');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'Standard')$$,
  '22023', null, 'a capitalised mode is refused (exact spelling only)');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', ' standard')$$,
  '22023', null, 'a mode with a leading space is refused');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', '')$$,
  '22023', null, 'an empty mode is refused');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'standard''; drop table public.agents; --')$$,
  '22023', null, 'a hostile mode string is refused');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002b1', 'standard')$$,
  'P0002', null, 'another workspace''s agent is not found from this workspace');
select throws_ok($$select public.set_agent_mode('99cbbbbb-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002b1', 'standard')$$,
  '42501', null, 'an owner of workspace A cannot change workspace B''s agent, naming workspace B');
select is((select count(*)::int from public.agent_mode_changes where workspace_id = '99caaaaa-0000-4000-8000-000000000001'), 2, 'AC2: the refusals left the workspace log at 2 rows');
select is((select mode from public.agents where id = '99200000-0000-4000-8000-0000000002a1'), 'strict', 'and Alpha did not move');

-- 5. AC2: an archived agent: refused with no row, allowed again after unarchive, then logged.
select lives_ok($$select public.archive_agent('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a3')$$, 'setup: archive Gamma');
select throws_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a3', 'standard')$$,
  '55000', null, 'an archived agent is refused');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99200000-0000-4000-8000-0000000002a3'), 0, 'the archived refusal left no row');
select lives_ok($$select public.unarchive_agent('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a3')$$, 'setup: unarchive Gamma');
select lives_ok($$select public.set_agent_mode('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a3', 'standard')$$,
  'after unarchive the change goes through');
select is((select count(*)::int from public.agent_mode_changes where agent_id = '99200000-0000-4000-8000-0000000002a3'), 1, 'and it is logged once');

-- 6. AC2: the owner of workspace B cannot reach A's agent through B either.
select set_config('request.jwt.claims', '{"sub":"99200000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.set_agent_mode('99cbbbbb-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'standard')$$,
  'P0002', null, 'workspace B''s owner naming A''s agent in B''s workspace finds nothing');
reset role;
select is((select count(*)::int from public.agent_mode_changes where workspace_id = '99cbbbbb-0000-4000-8000-000000000001'), 0, 'workspace B has no log rows');

-- 7. AC2: no direct write moves a mode, in either direction; a no-change update passes the guard.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"99200000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$update public.agents set mode = 'strict' where id = '99200000-0000-4000-8000-0000000002a3'$$,
  '42501', null, 'AC2: an owner cannot demote Gamma by updating the column directly');
reset role;
set local role service_role;
select throws_ok($$update public.agents set mode = 'strict' where id = '99200000-0000-4000-8000-0000000002a3'$$,
  '42501', null, 'AC2: service_role cannot demote an agent directly');
select throws_ok($$update public.agents set mode = 'relaxed' where id = '99200000-0000-4000-8000-0000000002a3'$$,
  '42501', null, 'AC2: service_role cannot promote an agent directly');
reset role;
select lives_ok($$update public.agents set mode = mode where id = '99200000-0000-4000-8000-0000000002a3'$$, 'an update that leaves the mode as it is passes the guard');
select is((select mode from public.agents where id = '99200000-0000-4000-8000-0000000002a3'), 'standard', 'Gamma is still Standard after every refused write');

-- 8. Reading the log: signed out cannot; the runtime (service_role) can.
set local role anon;
select throws_ok($$select count(*) from public.agent_mode_changes$$, '42501', null, 'a signed-out caller cannot read the log');
reset role;
set local role service_role;
select cmp_ok((select count(*)::int from public.agent_mode_changes), '>=', 3, 'service_role can read the log');
reset role;

-- 9. The log table keeps its own rules even for the table owner.
select throws_ok($$insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by) values ('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'strict', 'strict', '99200000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'a row whose from and to are the same is refused');
select throws_ok($$insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by) values ('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'strict', 'bogus', '99200000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'a row with a mode outside the list is refused');
select throws_ok($$insert into public.agent_mode_changes (workspace_id, agent_id, from_mode, to_mode, changed_by) values ('99caaaaa-0000-4000-8000-000000000001', '99200000-0000-4000-8000-0000000002a1', 'strict', 'standard', '99200000-0000-4000-8000-0000000001b1')$$,
  '23503', null, 'a row naming a member of another workspace is refused');

select * from finish();
rollback;
