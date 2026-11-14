-- AGO-74: core schema guarantees. Run: pnpm exec supabase test db (inside the db lock).
-- Catalog-driven checks (RLS, workspace_id, uuid PK) cover every table in `public`, including
-- tables added by later tickets, so a new table without RLS or workspace_id fails here.
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- 1. the 13 core tables exist
select has_table('public', t, t || ' exists')
from unnest(array[
  'workspaces','members','agents','skills','agent_skills','agent_capabilities','tasks',
  'runs','run_events','approvals','claims','budgets_usage','notes_index'
]) as t;

-- 2. RLS is enabled on every public table (deny-by-default until AGO-107 adds policies)
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'RLS is enabled on every table in public');

-- 3. every table has a uuid primary key named id
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = c.oid and i.indisprimary and a.attname = 'id' and a.atttypid = 'uuid'::regtype
          and i.indnatts = 1)),
  0, 'every table has a single-column uuid primary key named id');

-- 4. every table except workspaces has workspace_id uuid NOT NULL
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'workspaces'
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'workspace_id' and a.atttypid = 'uuid'::regtype
          and a.attnotnull and not a.attisdropped)),
  0, 'every table except workspaces has workspace_id uuid not null');

-- 5. every table except workspaces has a foreign key that includes workspace_id
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'workspaces'
      and not exists (
        select 1 from pg_constraint k
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
        where k.conrelid = c.oid and k.contype = 'f' and a.attname = 'workspace_id')),
  0, 'every table except workspaces has a foreign key on workspace_id');

-- 6. every table has created_at and (except run_events) updated_at, both timestamptz not null
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (c.relname <> 'agent_credentials' and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'created_at'
             and a.atttypid = 'timestamptz'::regtype and a.attnotnull)
        or (c.relname not in ('run_events', 'skill_versions', 'agent_versions', 'agent_credentials', 'agent_identities', 'claim_events') and not exists (select 1 from pg_attribute a where a.attrelid = c.oid
             and a.attname = 'updated_at' and a.atttypid = 'timestamptz'::regtype and a.attnotnull)))),
  0, 'every table has timestamptz created_at/updated_at (run_events, skill_versions, agent_versions, agent_credentials, agent_identities and claim_events have no updated_at; agent_credentials stamps issued_at instead of created_at)');

-- 7. run_events: append-only-ready (no updated_at, ordering column)
select hasnt_column('public', 'run_events', 'updated_at', 'run_events has no updated_at');
select has_column('public', 'run_events', 'seq', 'run_events has an ordering column');

-- 8. approvals carry hash, expiry and single-use state; no raw payload column
select has_column('public', 'approvals', 'payload_hash', 'approvals.payload_hash');
select col_not_null('public', 'approvals', 'expires_at', 'approvals.expires_at is not null');
select has_column('public', 'approvals', 'consumed_at', 'approvals.consumed_at (single use)');
select hasnt_column('public', 'approvals', 'payload', 'approvals store no raw payload');

-- 9. fixtures: two workspaces, one row in every table for workspace A
insert into auth.users (id, instance_id, aud, role, email)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago74-a@example.test');
insert into public.workspaces (id, name, created_at, updated_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'A', now() - interval '1 day', now() - interval '1 day'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'B', now(), now());
insert into public.members (id, workspace_id, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1');
insert into public.agents (id, workspace_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'agent-a'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'agent-b');
insert into public.skills (id, workspace_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'skill-a'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', 'skill-b');
insert into public.agent_skills (workspace_id, agent_id, skill_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004');
insert into public.agent_capabilities (workspace_id, agent_id, capability, granted_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'read_notes', 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.tasks (id, workspace_id, title, agent_id, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'task-a',
   'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000003');
insert into public.approvals (workspace_id, run_id, agent_id, action, payload_hash, expires_at, decided_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000006',
   'aaaaaaaa-0000-0000-0000-000000000003', 'send_email', repeat('a', 64), now() + interval '1 hour',
   'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.claims (workspace_id, task_id, agent_id, run_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000005',
   'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000006');
insert into public.budgets_usage (workspace_id, agent_id, period_start, period_end) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', '2026-11-01', '2026-12-01'),
  ('aaaaaaaa-0000-0000-0000-000000000001', null, '2026-11-01', '2026-12-01');
insert into public.notes_index (workspace_id, path) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'notes/a.md');

-- 10. updated_at trigger works, and also as service_role (which has no USAGE on private)
set local role service_role;
update public.workspaces set name = 'A2' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select ok(
  (select updated_at > created_at from public.workspaces where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'updated_at is stamped on update (as service_role, no grants on private)');

-- 11. deny-by-default: anon/authenticated hold no table privileges and no policies exist yet.
-- (a) durable: RLS does not cover TRUNCATE, so no public table may grant it to the API roles
select is(
  (select count(*)::int from pg_class c, unnest(array['anon', 'authenticated']) r
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and has_table_privilege(r, c.oid, 'TRUNCATE')),
  0, 'anon/authenticated have no TRUNCATE on any public table');
-- (b) durable: run_events stays append-only for the API roles (AGO-102 builds on this)
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r, unnest(array['UPDATE', 'DELETE']) p
    where has_table_privilege(r, 'public.run_events'::regclass, p)),
  0, 'anon/authenticated cannot UPDATE or DELETE run_events');
-- (c) anon holds nothing on any table. authenticated's exact privileges and policies are asserted by
-- rls_catalog.test.sql and rls_every_table.test.sql (AGO-107).
select is(
  (select count(*)::int from pg_class c, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and has_table_privilege('anon', c.oid, p)),
  0, 'anon has no table privileges at all');

-- 12. tenancy: a child cannot reference another workspace's parent
select throws_ok(
  $$insert into public.agent_skills (workspace_id, agent_id, skill_id) values
    ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000004')$$,
  '23503', null, 'agent_skills cannot mix workspaces (composite FK)');
select throws_ok(
  $$insert into public.runs (workspace_id, agent_id) values
    ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003')$$,
  '23503', null, 'runs cannot use an agent from another workspace');

-- 13. constraints
select throws_ok(
  $$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'x', 'not-a-hash', now())$$,
  '23514', null, 'approvals reject a payload_hash that is not 64 hex chars');
select throws_ok(
  $$insert into public.claims (workspace_id, task_id, agent_id) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000003')$$,
  '23505', null, 'only one active claim per task');

-- 14. deleting an agent that has run history is refused (history is kept)
select throws_ok(
  $$delete from public.agents where id = 'aaaaaaaa-0000-0000-0000-000000000003'$$,
  '23503', null, 'agent with runs cannot be deleted');

-- 15. deleting a workspace cascades to every table except run_events (nothing left behind). A has no
-- events here: run_events is append-only and its workspace FK is ON DELETE RESTRICT (AGO-102).
delete from public.workspaces where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from (
     select workspace_id from public.members union all select workspace_id from public.agents
     union all select workspace_id from public.skills union all select workspace_id from public.agent_skills
     union all select workspace_id from public.agent_capabilities union all select workspace_id from public.tasks
     union all select workspace_id from public.runs
     union all select workspace_id from public.approvals union all select workspace_id from public.claims
     union all select workspace_id from public.budgets_usage union all select workspace_id from public.notes_index
   ) x where x.workspace_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'deleting a workspace without events removes its rows from all 11 other child tables');

-- 16. a workspace that has run events cannot be deleted (erasure of events is human-only: AGO-147)
insert into public.runs (id, workspace_id, agent_id) values
  ('bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000003');
insert into public.run_events (workspace_id, run_id, type) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000006', 'run.started');
select throws_ok(
  $$delete from public.workspaces where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  '23503', null, 'deleting a workspace that has run_events is refused (ON DELETE RESTRICT)');
select is(
  (select count(*)::int from public.agents where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  + (select count(*)::int from public.run_events where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  2, 'the refused delete left the workspace data and its events untouched');

select * from finish();
rollback;
