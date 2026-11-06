-- AGO-96: nullable department_id hooks on agents, tasks, approvals and notes_index, and the layered
-- `policies` table (baseline, department, team, agent).
--   AC1  columns and table exist; RLS per role (owner-only writes, no delete, no cross-workspace access)
--   AC2  existing flows work unchanged with department_id null (agents, tasks, notes, approvals)
--   AC3  rollback is proven by scripts/ago-96-rollback.test.mjs (apply down, re-apply, empty diff)
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, e = removed from A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('96000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago96-o@example.test'),
  ('96000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago96-m@example.test'),
  ('96000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago96-v@example.test'),
  ('96000000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago96-e@example.test'),
  ('96000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago96-b@example.test');
insert into public.workspaces (id, name) values
  ('96aaaaaa-0000-4000-8000-000000000001', 'AGO-96 A'),
  ('96bbbbbb-0000-4000-8000-000000000001', 'AGO-96 B');
insert into public.members (id, workspace_id, user_id, role, removed_at) values
  ('96000000-0000-4000-8000-0000000001a1', '96aaaaaa-0000-4000-8000-000000000001', '96000000-0000-4000-8000-00000000000a', 'owner', null),
  ('96000000-0000-4000-8000-0000000001a2', '96aaaaaa-0000-4000-8000-000000000001', '96000000-0000-4000-8000-00000000000c', 'member', null),
  ('96000000-0000-4000-8000-0000000001a3', '96aaaaaa-0000-4000-8000-000000000001', '96000000-0000-4000-8000-00000000000d', 'viewer', null),
  ('96000000-0000-4000-8000-0000000001a4', '96aaaaaa-0000-4000-8000-000000000001', '96000000-0000-4000-8000-00000000000e', 'owner', now()),
  ('96000000-0000-4000-8000-0000000001b1', '96bbbbbb-0000-4000-8000-000000000001', '96000000-0000-4000-8000-00000000000b', 'owner', null);
insert into public.agents (id, workspace_id, name) values
  ('96000000-0000-4000-8000-0000000002a1', '96aaaaaa-0000-4000-8000-000000000001', 'agent-a');
insert into public.tasks (id, workspace_id, title) values
  ('96000000-0000-4000-8000-0000000006a1', '96aaaaaa-0000-4000-8000-000000000001', 'task-a');
insert into public.notes_index (id, workspace_id, path) values
  ('96000000-0000-4000-8000-0000000012a1', '96aaaaaa-0000-4000-8000-000000000001', 'a.md');
insert into public.approvals (id, workspace_id, agent_id, action, payload_hash, expires_at) values
  ('96000000-0000-4000-8000-0000000009a1', '96aaaaaa-0000-4000-8000-000000000001', '96000000-0000-4000-8000-0000000002a1', 'send_email', repeat('a', 64), now() + interval '1 hour');

-- 1-3. AC1: the department hooks exist, are nullable uuid columns, carry no FK yet, and are null on existing rows
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and column_name = 'department_id' and data_type = 'uuid' and is_nullable = 'YES'
      and table_name in ('agents', 'tasks', 'approvals', 'notes_index')),
  4, 'AC1: agents, tasks, approvals and notes_index each have a nullable uuid department_id');
select is(
  (select count(*)::int from information_schema.columns where table_schema = 'public' and column_name = 'department_id'),
  4, 'AC1: department_id exists on those four tables and nowhere else');
select is(
  (select count(*)::int from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and a.attname = 'department_id'),
  0, 'AC1: department_id has no foreign key yet (the departments table is AGO-108)');

-- 4-7. AC2: existing rows read back with a null department
select is((select count(*)::int from public.agents where department_id is not null), 0, 'AC2: existing agent has a null department');
select is((select count(*)::int from public.tasks where department_id is not null), 0, 'AC2: existing task has a null department');
select is((select count(*)::int from public.notes_index where department_id is not null), 0, 'AC2: existing note has a null department');
select is((select count(*)::int from public.approvals where department_id is not null), 0, 'AC2: existing approval has a null department');

-- 8-13. AC1: policies table shape and constraints (as postgres)
select has_table('public', 'policies', 'AC1: public.policies exists');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'galaxy', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'AC1: a level outside baseline/department/team/agent is rejected');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'baseline', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'AC1: a baseline policy cannot carry a scope id');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'agent', null, '{}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'AC1: a department, team or agent policy must carry a scope id');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'baseline', null, '[]',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'AC1: the rule must be a JSON object');
select lives_ok(
  $$insert into public.policies (id, workspace_id, level, scope_id, rule, created_by, updated_by) values
    ('96000000-0000-4000-8000-0000000013a1', '96aaaaaa-0000-4000-8000-000000000001', 'baseline', null, '{"version":1,"rules":[]}',
     '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1'),
    ('96000000-0000-4000-8000-0000000013b1', '96bbbbbb-0000-4000-8000-000000000001', 'baseline', null, '{"version":1,"rules":[]}',
     '96000000-0000-4000-8000-0000000001b1', '96000000-0000-4000-8000-0000000001b1')$$,
  'AC1: a baseline policy (no scope) is accepted in each workspace');

-- 14-17. one active policy per scope; archiving frees the slot; created_by must be a member of the same workspace
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'baseline', null, '{}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '23505', null, 'AC1: a second active baseline in the same workspace is rejected');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'team', '96000000-0000-4000-8000-0000000015a1', '{}',
            '96000000-0000-4000-8000-0000000001b1', '96000000-0000-4000-8000-0000000001b1')$$,
  '23503', null, 'AC1: created_by must be a member of the same workspace (composite FK)');
insert into public.policies (id, workspace_id, level, scope_id, rule, created_by, updated_by) values
  ('96000000-0000-4000-8000-0000000013d1', '96aaaaaa-0000-4000-8000-000000000001', 'team', '96000000-0000-4000-8000-0000000015a1', '{"version":1,"rules":[]}',
   '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1');
update public.policies set archived_at = now() where id = '96000000-0000-4000-8000-0000000013d1';
select lives_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'team', '96000000-0000-4000-8000-0000000015a1', '{"version":1,"rules":[]}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  'AC1: archiving a policy frees its scope for a new active one');
select is((select count(*)::int from public.policies where level = 'team' and scope_id = '96000000-0000-4000-8000-0000000015a1'), 2,
  'AC1: the archived policy is kept (history is not deleted)');

-- 18-20. version moves forward on every rule change and cannot be chosen by the caller
update public.policies set rule = '{"version":1,"rules":[{"action":"send_email","effect":"deny"}]}' where id = '96000000-0000-4000-8000-0000000013a1';
select is((select version from public.policies where id = '96000000-0000-4000-8000-0000000013a1'), 2, 'AC1: a rule change bumps the version');
update public.policies set rule = rule where id = '96000000-0000-4000-8000-0000000013a1';
select is((select version from public.policies where id = '96000000-0000-4000-8000-0000000013a1'), 2, 'AC1: an update that leaves the rule alone keeps the version');
update public.policies set rule = '{"version":1,"rules":[]}', version = 99 where id = '96000000-0000-4000-8000-0000000013a1';
select is((select version from public.policies where id = '96000000-0000-4000-8000-0000000013a1'), 3, 'AC1: the version is set by the trigger, not by the caller');

-- 21-31. owner of A: the only role that writes policies
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.policies), 3, 'owner A reads A''s policies (baseline and team x2, none of B)');
select is((select count(*)::int from public.policies where workspace_id = '96bbbbbb-0000-4000-8000-000000000001'), 0, 'AC1: owner A cannot read B''s policies');
select lives_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'department', '96000000-0000-4000-8000-0000000014a1', '{"version":1,"rules":[]}',
            '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  'AC1: an owner can write a department policy as themselves');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'agent', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a2', '96000000-0000-4000-8000-0000000001a2')$$,
  '42501', null, 'an owner cannot attribute a policy to another member (created_by is pinned to the caller)');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96bbbbbb-0000-4000-8000-000000000001', 'agent', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001b1', '96000000-0000-4000-8000-0000000001b1')$$,
  '42501', null, 'AC1: an owner of A cannot plant a policy in workspace B');
with u as (update public.policies set rule = '{"version":1,"rules":[{"action":"x","effect":"require_approval"}]}',
                  updated_by = '96000000-0000-4000-8000-0000000001a1'
           where id = '96000000-0000-4000-8000-0000000013a1' returning version)
select is((select version from u), 4, 'an owner can change a rule (and the version moves)');
select throws_ok(
  $$update public.policies set rule = '{}', updated_by = '96000000-0000-4000-8000-0000000001a2' where id = '96000000-0000-4000-8000-0000000013a1'$$,
  '42501', null, 'an owner cannot record someone else as the editor (updated_by is pinned to the caller)');
with u as (update public.policies set archived_at = now(), updated_by = '96000000-0000-4000-8000-0000000001a1'
           where id = '96000000-0000-4000-8000-0000000013a1' returning 1)
select is((select count(*)::int from u), 1, 'an owner can archive a policy');
with u as (update public.policies set rule = '{}', updated_by = '96000000-0000-4000-8000-0000000001a1'
           where id = '96000000-0000-4000-8000-0000000013a1' returning 1)
select is((select count(*)::int from u), 0, 'an archived policy is history: an owner can no longer edit or un-archive it (0 rows)');
select throws_ok($$update public.policies set level = 'agent' where id = '96000000-0000-4000-8000-0000000013a1'$$, '42501', null,
  'level is immutable (no UPDATE privilege)');
select throws_ok($$update public.policies set scope_id = '96000000-0000-4000-8000-0000000002a1' where id = '96000000-0000-4000-8000-0000000013a1'$$, '42501', null,
  'scope_id is immutable (no UPDATE privilege)');
select throws_ok($$update public.policies set workspace_id = '96bbbbbb-0000-4000-8000-000000000001' where id = '96000000-0000-4000-8000-0000000013a1'$$, '42501', null,
  'AC1: a policy cannot be moved to another workspace (no UPDATE privilege)');
select throws_ok($$update public.policies set version = 50 where id = '96000000-0000-4000-8000-0000000013a1'$$, '42501', null,
  'version cannot be written through the API');
select throws_ok($$delete from public.policies where id = '96000000-0000-4000-8000-0000000013a1'$$, '42501', null,
  'nobody deletes a policy through the API, not even an owner (archive instead)');
reset role;

-- 32-37. member and viewer of A read policies but never write them
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select is((select count(*)::int from public.policies), 4, 'member reads A''s policies');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'agent', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a2', '96000000-0000-4000-8000-0000000001a2')$$,
  '42501', null, 'a member cannot write a policy');
with u as (update public.policies set rule = '{}', updated_by = '96000000-0000-4000-8000-0000000001a2' returning 1)
select is((select count(*)::int from u), 0, 'a member cannot change any policy (0 rows)');
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.policies), 4, 'viewer reads A''s policies');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'agent', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a3', '96000000-0000-4000-8000-0000000001a3')$$,
  '42501', null, 'a viewer cannot write a policy');
with u as (update public.policies set archived_at = now(), updated_by = '96000000-0000-4000-8000-0000000001a3' returning 1)
select is((select count(*)::int from u), 0, 'a viewer cannot archive any policy (0 rows)');
reset role;

-- 38-42. a removed owner of A and the owner of B
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
select is((select count(*)::int from public.policies), 0, 'a removed owner sees no policies');
select throws_ok(
  $$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'agent', '96000000-0000-4000-8000-0000000002a1', '{}',
            '96000000-0000-4000-8000-0000000001a4', '96000000-0000-4000-8000-0000000001a4')$$,
  '42501', null, 'a removed owner cannot write a policy');
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select results_eq($$select id from public.policies$$, $$values ('96000000-0000-4000-8000-0000000013b1'::uuid)$$,
  'AC1: owner B sees only B''s policy');
with u as (update public.policies set rule = '{}', updated_by = '96000000-0000-4000-8000-0000000001b1'
           where workspace_id = '96aaaaaa-0000-4000-8000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'AC1: owner B cannot change A''s policies (0 rows)');
select throws_ok($$delete from public.policies$$, '42501', null, 'owner B cannot delete policies either');
reset role;

-- 43-44. anon holds nothing
set local role anon;
select throws_ok($$select 1 from public.policies$$, '42501', null, 'anon cannot read policies');
select throws_ok(
  $$insert into public.policies (workspace_id, level, rule, created_by, updated_by)
    values ('96aaaaaa-0000-4000-8000-000000000001', 'baseline', '{}', '96000000-0000-4000-8000-0000000001a1', '96000000-0000-4000-8000-0000000001a1')$$,
  '42501', null, 'anon cannot write policies');
reset role;

-- 45-52. AC2: existing flows work unchanged with department_id null (member of A, normal work)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"96000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select lives_ok($$insert into public.agents (workspace_id, name) values ('96aaaaaa-0000-4000-8000-000000000001', 'agent-new')$$,
  'AC2: a member creates an agent without a department');
select lives_ok($$insert into public.tasks (workspace_id, title) values ('96aaaaaa-0000-4000-8000-000000000001', 'task-new')$$,
  'AC2: a member creates a task without a department');
select lives_ok($$insert into public.notes_index (workspace_id, path) values ('96aaaaaa-0000-4000-8000-000000000001', 'new.md')$$,
  'AC2: a member indexes a note without a department');
with u as (update public.approvals set status = 'approved', decided_at = now(), decided_by = '96000000-0000-4000-8000-0000000001a2'
           where id = '96000000-0000-4000-8000-0000000009a1' returning 1)
select is((select count(*)::int from u), 1, 'AC2: a member decides a pending approval that has no department');
select is((select count(*)::int from public.agents where department_id is null), 2, 'AC2: both agents read back with a null department');
select throws_ok($$insert into public.agents (workspace_id, name, department_id) values ('96aaaaaa-0000-4000-8000-000000000001', 'sneaky', '96000000-0000-4000-8000-0000000014a1')$$,
  '42501', null, 'department_id is not writable through the API yet (insert)');
select throws_ok($$update public.tasks set department_id = '96000000-0000-4000-8000-0000000014a1' where id = '96000000-0000-4000-8000-0000000006a1'$$,
  '42501', null, 'department_id is not writable through the API yet (update)');
select throws_ok($$update public.approvals set department_id = '96000000-0000-4000-8000-0000000014a1' where id = '96000000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'an approval cannot be re-scoped to a department by a human decider');
reset role;

select * from finish();
rollback;
