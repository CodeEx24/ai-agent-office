-- AGO-128: the skill library with versions.
--   AC1  saving an edit stores a new version and the old one remains; versions are immutable for every role
--   AC2  a skill can be assigned to and removed from an agent (owners only)
--   AC3  members and viewers read; only owners write; workspaces are isolated; the text is size-capped
-- The AGO-107 catalog test (rls_catalog.test.sql) and the role matrix (rls_every_table.test.sql) also cover
-- the new table's RLS, grants and pinned search_path automatically.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('12800000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago128-o@example.test'),
  ('12800000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago128-m@example.test'),
  ('12800000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago128-v@example.test'),
  ('12800000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago128-b@example.test');
insert into public.workspaces (id, name) values
  ('128aaaaa-0000-4000-8000-000000000001', 'AGO-128 A'),
  ('128bbbbb-0000-4000-8000-000000000001', 'AGO-128 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('12800000-0000-4000-8000-0000000001a1', '128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-00000000000a', 'owner'),
  ('12800000-0000-4000-8000-0000000001a2', '128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-00000000000c', 'member'),
  ('12800000-0000-4000-8000-0000000001a3', '128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-00000000000d', 'viewer'),
  ('12800000-0000-4000-8000-0000000001b1', '128bbbbb-0000-4000-8000-000000000001', '12800000-0000-4000-8000-00000000000b', 'owner');
insert into public.agents (id, workspace_id, name) values
  ('12800000-0000-4000-8000-0000000002a1', '128aaaaa-0000-4000-8000-000000000001', 'Agent A'),
  ('12800000-0000-4000-8000-0000000002b1', '128bbbbb-0000-4000-8000-000000000001', 'Agent B');
insert into public.skills (id, workspace_id, name, body) values
  ('12800000-0000-4000-8000-0000000003a1', '128aaaaa-0000-4000-8000-000000000001', 'skill-a', 'one'),
  ('12800000-0000-4000-8000-0000000003b1', '128bbbbb-0000-4000-8000-000000000001', 'skill-b', 'bee');

-- 1-4. AC1: creating a skill stores version 1
select has_table('public', 'skill_versions', 'AC1: public.skill_versions exists');
select is((select count(*)::int from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 1,
  'AC1: a new skill has exactly one version');
select is((select version from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 1, 'AC1: and it is version 1');
select is((select body from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 1), 'one',
  'AC1: version 1 holds the original text');

-- 5-12. AC1: an edit stores a new version and the old one remains
update public.skills set body = 'two' where id = '12800000-0000-4000-8000-0000000003a1';
select is((select version from public.skills where id = '12800000-0000-4000-8000-0000000003a1'), 2, 'AC1: saving an edit moves the skill to version 2');
select is((select count(*)::int from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 2, 'AC1: a second version row is stored');
select is((select body from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 1), 'one',
  'AC1: the old version still holds the old text');
select is((select body from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 2), 'two',
  'AC1: the new version holds the new text');
update public.skills set description = 'only metadata' where id = '12800000-0000-4000-8000-0000000003a1';
select is((select version from public.skills where id = '12800000-0000-4000-8000-0000000003a1'), 2, 'AC1: a description-only edit does not add a version');
update public.skills set body = body where id = '12800000-0000-4000-8000-0000000003a1';
select is((select count(*)::int from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 2, 'AC1: saving identical text does not add a version');
update public.skills set body = 'three', version = 50 where id = '12800000-0000-4000-8000-0000000003a1';
select is((select version from public.skills where id = '12800000-0000-4000-8000-0000000003a1'), 3, 'AC1: a forged version number is ignored: the next version is always +1');
select is((select body from public.skills where id = '12800000-0000-4000-8000-0000000003a1'),
  (select body from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' order by version desc limit 1),
  'AC1: the skill current text equals its latest version');

-- 13-18. versions are immutable, even for the table owner (as postgres)
select throws_ok($$update public.skill_versions set body = 'tampered' where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 1$$,
  '42501', null, 'AC1: a version cannot be updated (any role)');
select throws_ok($$delete from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 1$$,
  '42501', null, 'AC1: a version cannot be deleted while its skill exists (any role)');
select is((select body from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 1), 'one',
  'AC1: version 1 is untouched after the blocked changes');
select throws_ok($$insert into public.skill_versions (workspace_id, skill_id, version, body)
  values ('128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000003a1', 2, 'dup')$$,
  '23505', null, 'AC1: a version number is unique per skill');
select throws_ok($$insert into public.skill_versions (workspace_id, skill_id, version, body)
  values ('128bbbbb-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000003a1', 9, 'cross')$$,
  '23503', null, 'isolation: a version cannot point at another workspace skill (composite FK)');
select throws_ok($$update public.skills set body = repeat('x', 20001) where id = '12800000-0000-4000-8000-0000000003a1'$$,
  '23514', null, 'AC3: skill text over 20000 characters is rejected');

-- 19-20. size limit boundary is accepted
select lives_ok($$update public.skills set body = repeat('x', 20000) where id = '12800000-0000-4000-8000-0000000003a1'$$,
  'AC3 (control): exactly 20000 characters is accepted');
select is((select char_length(body) from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1' and version = 4), 20000,
  'AC3: and stored in full as version 4');

-- 21-33. owner of A (authenticated)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"12800000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$insert into public.skills (workspace_id, name, description, body)
  values ('128aaaaa-0000-4000-8000-000000000001', 'owner-skill', 'd', '# v1')$$, 'AC1: an owner can create a skill');
select is((select created_by from public.skills s join public.skill_versions v on v.skill_id = s.id and v.version = 1
  where s.name = 'owner-skill' limit 1), '12800000-0000-4000-8000-0000000001a1'::uuid,
  'AC1: the first version records the owner who saved it');
with u as (update public.skills set body = '# v2' where name = 'owner-skill' returning 1)
select is((select count(*)::int from u), 1, 'AC1: an owner can edit a skill');
select is((select count(*)::int from public.skill_versions v join public.skills s on s.id = v.skill_id where s.name = 'owner-skill'), 2,
  'AC1: the owner edit stored version 2 and kept version 1');
select is((select created_by from public.skills s join public.skill_versions v on v.skill_id = s.id and v.version = 2
  where s.name = 'owner-skill' limit 1), '12800000-0000-4000-8000-0000000001a1'::uuid, 'AC1: version 2 records the owner too');
select throws_ok($$update public.skills set version = 9 where name = 'owner-skill'$$, '42501', null, 'AC1: not even an owner can write the version number');
select throws_ok($$update public.skills set workspace_id = '128bbbbb-0000-4000-8000-000000000001' where name = 'owner-skill'$$, '42501', null,
  'isolation: an owner cannot move a skill to another workspace');
select throws_ok($$delete from public.skills where name = 'owner-skill'$$, '42501', null, 'AC1: nobody deletes a skill through the API');
select throws_ok($$update public.skill_versions set body = 'tampered' where version = 1$$, '42501', null, 'AC1: an owner cannot update a version through the API');
select throws_ok($$delete from public.skill_versions where version = 1$$, '42501', null, 'AC1: an owner cannot delete a version through the API');
select throws_ok($$insert into public.skill_versions (workspace_id, skill_id, version, body)
  values ('128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000003a1', 99, 'forged')$$,
  '42501', null, 'AC1: an owner cannot insert a version directly: only saving the skill does');
select lives_ok($$insert into public.agent_skills (workspace_id, agent_id, skill_id)
  values ('128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000002a1', '12800000-0000-4000-8000-0000000003a1')$$,
  'AC2: an owner can assign a skill to an agent');
with d as (delete from public.agent_skills where skill_id = '12800000-0000-4000-8000-0000000003a1' returning 1)
select is((select count(*)::int from d), 1, 'AC2: an owner can remove it again');

-- 34-39. member of A: reads, cannot write
select set_config('request.jwt.claims', '{"sub":"12800000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select cmp_ok((select count(*)::int from public.skill_versions), '>=', 6, 'AC3: a member reads the versions of their workspace');
select is((select count(*)::int from public.skill_versions where workspace_id = '128bbbbb-0000-4000-8000-000000000001'), 0, 'isolation: a member of A cannot read B versions');
select throws_ok($$insert into public.skills (workspace_id, name, body) values ('128aaaaa-0000-4000-8000-000000000001', 'member-skill', 'x')$$,
  '42501', null, 'AC3: a member cannot create a skill');
with u as (update public.skills set body = 'member edit' where id = '12800000-0000-4000-8000-0000000003a1' returning 1)
select is((select count(*)::int from u), 0, 'AC3: a member edit changes no row');
select is((select version from public.skills where id = '12800000-0000-4000-8000-0000000003a1'), 4, 'AC3: and stores no new version');
select throws_ok($$insert into public.agent_skills (workspace_id, agent_id, skill_id)
  values ('128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000002a1', '12800000-0000-4000-8000-0000000003a1')$$,
  '42501', null, 'AC2: a member cannot assign a skill');

-- 40-43. viewer of A
select set_config('request.jwt.claims', '{"sub":"12800000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select cmp_ok((select count(*)::int from public.skills), '>=', 2, 'AC3: a viewer reads the skills');
select cmp_ok((select count(*)::int from public.skill_versions), '>=', 6, 'AC3: a viewer reads the versions');
with u as (update public.skills set body = 'viewer edit' where id = '12800000-0000-4000-8000-0000000003a1' returning 1)
select is((select count(*)::int from u), 0, 'AC3: a viewer edit changes no row');
select throws_ok($$insert into public.skills (workspace_id, name, body) values ('128aaaaa-0000-4000-8000-000000000001', 'viewer-skill', 'x')$$,
  '42501', null, 'AC3: a viewer cannot create a skill');

-- 44-50. an owner of B cannot touch A
select set_config('request.jwt.claims', '{"sub":"12800000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.skills where workspace_id = '128aaaaa-0000-4000-8000-000000000001'), 0, 'isolation: an owner of B cannot read A skills');
select is((select count(*)::int from public.skill_versions where workspace_id = '128aaaaa-0000-4000-8000-000000000001'), 0, 'isolation: nor A versions');
with u as (update public.skills set body = 'b edit' where workspace_id = '128aaaaa-0000-4000-8000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'isolation: nor edit A skills');
select throws_ok($$insert into public.skills (workspace_id, name, body) values ('128aaaaa-0000-4000-8000-000000000001', 'intruder', 'x')$$,
  '42501', null, 'isolation: nor create a skill in A');
select throws_ok($$insert into public.agent_skills (workspace_id, agent_id, skill_id)
  values ('128aaaaa-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000002a1', '12800000-0000-4000-8000-0000000003a1')$$,
  '42501', null, 'isolation: nor assign A skill');
select throws_ok($$insert into public.agent_skills (workspace_id, agent_id, skill_id)
  values ('128bbbbb-0000-4000-8000-000000000001', '12800000-0000-4000-8000-0000000002b1', '12800000-0000-4000-8000-0000000003a1')$$,
  '23503', null, 'isolation: nor link B agent to A skill (composite FK)');
select is((select count(*)::int from public.skill_versions), 1, 'isolation: an owner of B sees exactly B one version');

-- 51-52. anon
reset role;
set local role anon;
select throws_ok($$select count(*) from public.skill_versions$$, '42501', null, 'anon cannot read versions');
select throws_ok($$select count(*) from public.skills$$, '42501', null, 'anon cannot read skills');

-- 53-62. append-only for EVERY role, service_role and the table owner included (AGO-102 run_events pattern)
reset role;
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r,
      unnest(array['UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) p
    where has_table_privilege(r, 'public.skill_versions'::regclass, p))
  + (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r
      where has_any_column_privilege(r, 'public.skill_versions'::regclass, 'UPDATE')),
  0, 'anon, authenticated and service_role hold no UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES on skill_versions (table or column level)');
select is(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.skill_versions'::regclass and not tgisinternal
      and tgname in ('skill_versions_block_update', 'skill_versions_block_delete', 'skill_versions_block_truncate')
      and tgenabled = 'A'),
  3, 'the 3 immutability triggers exist and are ENABLE ALWAYS (they fire even in replica mode)');
select throws_ok($$truncate public.skill_versions$$, '42501', null, 'the table owner cannot TRUNCATE skill_versions (trigger)');
select throws_ok($$truncate public.skills cascade$$, '42501', null, 'a TRUNCATE ... CASCADE from skills cannot empty skill_versions either');
set local role service_role;
select throws_ok($$update public.skill_versions set body = 'tampered' where version = 1$$, '42501', null, 'service_role cannot UPDATE a version');
select throws_ok($$delete from public.skill_versions where version = 1$$, '42501', null, 'service_role cannot DELETE a version');
select throws_ok($$truncate public.skill_versions$$, '42501', null, 'service_role cannot TRUNCATE skill_versions');
reset role;
set local role authenticated;
select throws_ok($$truncate public.skill_versions$$, '42501', null, 'authenticated cannot TRUNCATE skill_versions');
reset role;
set local role anon;
select throws_ok($$truncate public.skill_versions$$, '42501', null, 'anon cannot TRUNCATE skill_versions');
reset role;
select is((select count(*)::int from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 4,
  'all four versions of the skill are intact after every blocked change');

-- 63-68. the trigger functions are closed to users, and deleting a skill or workspace still cascades
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"12800000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select private.append_skill_version()$$, '42501', null, 'a signed-in user cannot call the version trigger function');
select throws_ok($$select private.skill_versions_block_change()$$, '42501', null, 'nor the immutability trigger function');
reset role;
select lives_ok($$delete from public.skills where id = '12800000-0000-4000-8000-0000000003a1'$$, 'a skill can be removed by the table owner (service path)');
select is((select count(*)::int from public.skill_versions where skill_id = '12800000-0000-4000-8000-0000000003a1'), 0,
  'its versions go with it (FK cascade), the only way a version row disappears');
select lives_ok($$delete from public.workspaces where id = '128bbbbb-0000-4000-8000-000000000001'$$, 'deleting a workspace cascades through skills and versions');
select is((select count(*)::int from public.skill_versions where workspace_id = '128bbbbb-0000-4000-8000-000000000001'), 0, 'no version of the deleted workspace remains');

select * from finish();
rollback;
