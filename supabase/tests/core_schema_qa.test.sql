-- AGO-74 QA: acceptance-criteria tests written independently of core_schema.test.sql.
-- Run: pnpm exec supabase test db (inside the db lock). Everything rolls back.
--   AC1  13 tables, PK, FKs, created_at/updated_at (run_events: created only)
--   AC2  workspace_id NOT NULL + indexed + FK to workspaces; composite FKs reject cross-workspace links
--   AC3  rollback/re-apply/db diff is a shell procedure (DDL cannot be proven inside a test transaction)
--   SEC  RLS on every table, anon/authenticated denied select+insert, approvals hash/expiry/single use,
--        no secret-bearing columns
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- ---------------------------------------------------------------------------------------------
-- AC1: schema shape
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')),
  21, 'AC1: public holds exactly 21 tables (13 core + policies + capabilities + skill_versions + agent_identities + agent_credentials + agent_versions + claim_events + pack_events)');

select is(
  (select array_agg(relname::text order by relname) from pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')),
  array['agent_capabilities','agent_credentials','agent_identities','agent_skills','agent_versions','agents','approvals','budgets_usage','capabilities','claim_events','claims','members',
        'notes_index','pack_events','policies','run_events','runs','skill_versions','skills','tasks','workspaces'],
  'AC1: the 21 tables are the specified ones');

select is(
  (select count(*)::int from pg_constraint k
    where k.contype = 'f' and k.connamespace = 'public'::regnamespace and k.confrelid <> 'public.workspaces'::regclass
      and k.confrelid <> 'auth.users'::regclass),
  26, 'AC1: 26 parent foreign keys between core tables (16 core + 2 on policies + 2 on skill_versions + 3 on agent_identities and agent_credentials + 2 on agent_versions + 1 on pack_events)');

select is(
  (select count(*)::int from pg_constraint
    where contype = 'f' and conrelid = 'public.members'::regclass and confrelid = 'auth.users'::regclass),
  1, 'AC1: members.user_id references auth.users');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and column_name in ('created_at', 'updated_at')
      and (column_default is null or column_default not like 'now()%')),
  0, 'AC1: created_at/updated_at default to now() on every table');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and column_name = 'id' and column_default not like 'gen_random_uuid()%'),
  0, 'AC1: every id defaults to gen_random_uuid()');

select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'updated_at')
      and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                        and t.tgfoid = 'private.set_updated_at()'::regprocedure)),
  0, 'AC1: every table with updated_at has the set_updated_at trigger');

-- ---------------------------------------------------------------------------------------------
-- AC2: workspace_id, index, FK to workspaces
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'workspaces'
      and not exists (
        select 1 from pg_constraint k
        where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'public.workspaces'::regclass
          and k.conkey = array[(select attnum from pg_attribute where attrelid = c.oid and attname = 'workspace_id')]
          and k.confkey = array[(select attnum from pg_attribute where attrelid = 'public.workspaces'::regclass and attname = 'id')])),
  0, 'AC2: every table has workspace_id -> workspaces(id) as a single-column FK');

select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'workspaces'
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.oid and i.indisvalid
          and i.indkey[0] = (select attnum from pg_attribute where attrelid = c.oid and attname = 'workspace_id'))),
  0, 'AC2: workspace_id is the leading column of an index on every table');

select is(
  (select string_agg(c.relname::text, ',' order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'workspaces'
      and not exists (
        select 1 from pg_constraint k
        where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'public.workspaces'::regclass
          and k.confdeltype = 'c')),
  'run_events', 'AC2: deleting a workspace cascades from every table except run_events (the only table without a cascade FK)');
select is(
  (select k.confdeltype::text from pg_constraint k
    where k.conrelid = 'public.run_events'::regclass and k.contype = 'f' and k.confrelid = 'public.workspaces'::regclass),
  'r', 'AC2: run_events -> workspaces is ON DELETE RESTRICT (append-only; erasure is human-only, AGO-147)');

select is(
  (select count(*)::int from pg_constraint k
    where k.contype = 'f' and k.connamespace = 'public'::regnamespace and cardinality(k.conkey) > 1
      and (k.conkey[1] <> (select attnum from pg_attribute where attrelid = k.conrelid and attname = 'workspace_id')
        or k.confkey[1] <> (select attnum from pg_attribute where attrelid = k.confrelid and attname = 'workspace_id'))),
  0, 'AC2: every composite FK is (workspace_id, x) -> (workspace_id, id)');

-- fixtures: workspace A and B, each with a full parent chain
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago74-qa-a@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago74-qa-b@example.test');
insert into public.workspaces (id, name) values
  ('c0000000-0000-0000-0000-00000000000a', 'QA A'),
  ('c0000000-0000-0000-0000-00000000000b', 'QA B');
insert into public.members (id, workspace_id, user_id) values
  ('c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1'),
  ('c0000000-0000-0000-0000-0000000000b1', 'c0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000c2');
insert into public.agents (id, workspace_id, name) values
  ('c0000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-00000000000a', 'agent-a'),
  ('c0000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-00000000000b', 'agent-b');
insert into public.skills (id, workspace_id, name) values
  ('c0000000-0000-0000-0000-0000000000a3', 'c0000000-0000-0000-0000-00000000000a', 'skill-a'),
  ('c0000000-0000-0000-0000-0000000000b3', 'c0000000-0000-0000-0000-00000000000b', 'skill-b');
insert into public.tasks (id, workspace_id, title) values
  ('c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-00000000000a', 'task-a'),
  ('c0000000-0000-0000-0000-0000000000b4', 'c0000000-0000-0000-0000-00000000000b', 'task-b');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('c0000000-0000-0000-0000-0000000000a5', 'c0000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-0000000000a2'),
  ('c0000000-0000-0000-0000-0000000000b5', 'c0000000-0000-0000-0000-00000000000b',
   'c0000000-0000-0000-0000-0000000000b4', 'c0000000-0000-0000-0000-0000000000b2');

-- positive controls: the same shapes succeed when everything is in one workspace
select lives_ok(
  $$insert into public.agent_capabilities (workspace_id, agent_id, capability, granted_by) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b2', 'read_notes', 'c0000000-0000-0000-0000-0000000000b1')$$,
  'AC2 control: same-workspace agent_capabilities insert works');
select lives_ok(
  $$insert into public.approvals (workspace_id, run_id, agent_id, action, payload_hash, expires_at, decided_by) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b5',
     'c0000000-0000-0000-0000-0000000000b2', 'send_email', repeat('b', 64), now() + interval '1 hour',
     'c0000000-0000-0000-0000-0000000000b1')$$,
  'AC2 control: same-workspace approvals insert works');

-- negatives: workspace B rows pointing at workspace A parents (23503 foreign_key_violation)
select throws_ok($$insert into public.agent_skills (workspace_id, agent_id, skill_id) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-0000000000a3')$$,
  '23503', null, 'AC2: agent_skills rejects a skill from another workspace');
select throws_ok($$insert into public.agent_capabilities (workspace_id, agent_id, capability) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a2', 'x')$$,
  '23503', null, 'AC2: agent_capabilities rejects an agent from another workspace');
select throws_ok($$insert into public.agent_capabilities (workspace_id, agent_id, capability, granted_by) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b2', 'y', 'c0000000-0000-0000-0000-0000000000a1')$$,
  '23503', null, 'AC2: agent_capabilities rejects granted_by from another workspace');
select throws_ok($$insert into public.tasks (workspace_id, title, agent_id) values
    ('c0000000-0000-0000-0000-00000000000b', 't', 'c0000000-0000-0000-0000-0000000000a2')$$,
  '23503', null, 'AC2: tasks rejects an agent from another workspace');
select throws_ok($$insert into public.tasks (workspace_id, title, created_by) values
    ('c0000000-0000-0000-0000-00000000000b', 't', 'c0000000-0000-0000-0000-0000000000a1')$$,
  '23503', null, 'AC2: tasks rejects created_by from another workspace');
select throws_ok($$insert into public.runs (workspace_id, task_id, agent_id) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-0000000000b2')$$,
  '23503', null, 'AC2: runs rejects a task from another workspace');
select throws_ok($$insert into public.run_events (workspace_id, run_id, type) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a5', 'run.started')$$,
  '23503', null, 'AC2: run_events rejects a run from another workspace');
select throws_ok($$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a2', 'x', repeat('a', 64), now())$$,
  '23503', null, 'AC2: approvals rejects an agent from another workspace');
select throws_ok($$insert into public.approvals (workspace_id, run_id, agent_id, action, payload_hash, expires_at) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a5',
     'c0000000-0000-0000-0000-0000000000b2', 'x', repeat('a', 64), now())$$,
  '23503', null, 'AC2: approvals rejects a run from another workspace');
select throws_ok($$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at, decided_by) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b2', 'x', repeat('a', 64), now(),
     'c0000000-0000-0000-0000-0000000000a1')$$,
  '23503', null, 'AC2: approvals rejects decided_by from another workspace');
select throws_ok($$insert into public.claims (workspace_id, task_id, agent_id) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-0000000000b2')$$,
  '23503', null, 'AC2: claims rejects a task from another workspace');
select throws_ok($$insert into public.claims (workspace_id, task_id, agent_id, run_id) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000b4',
     'c0000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-0000000000a5')$$,
  '23503', null, 'AC2: claims rejects a run from another workspace');
select throws_ok($$insert into public.budgets_usage (workspace_id, agent_id, period_start, period_end) values
    ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-0000000000a2', '2026-11-01', '2026-12-01')$$,
  '23503', null, 'AC2: budgets_usage rejects an agent from another workspace');
select throws_ok($$insert into public.notes_index (workspace_id, path) values
    ('c0000000-0000-0000-0000-0000000000ff', 'n.md')$$,
  '23503', null, 'AC2: a row for a non-existent workspace is rejected');
select throws_ok($$insert into public.notes_index (path) values ('n.md')$$,
  '23502', null, 'AC2: workspace_id is required (not null)');
select throws_ok($$update public.agents set workspace_id = 'c0000000-0000-0000-0000-00000000000b'
    where id = 'c0000000-0000-0000-0000-0000000000a2'$$,
  '23503', null, 'AC2: re-homing an agent that has runs to another workspace is refused');
-- double submit: a duplicate is rejected, not duplicated
select throws_ok($$insert into public.members (workspace_id, user_id) values
    ('c0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1')$$,
  '23505', null, 'AC2 edge: the same user cannot join a workspace twice');
select throws_ok($$insert into public.agents (workspace_id, name) values
    ('c0000000-0000-0000-0000-00000000000a', 'agent-a')$$,
  '23505', null, 'AC2 edge: duplicate agent name in a workspace is rejected');
select lives_ok($$insert into public.agents (workspace_id, name) values
    ('c0000000-0000-0000-0000-00000000000b', 'agent-a')$$,
  'AC2 edge: the same agent name is fine in a different workspace');
-- empty input
select throws_ok($$insert into public.agents (workspace_id, name) values
    ('c0000000-0000-0000-0000-00000000000a', '')$$,
  '23514', null, 'AC2 edge: empty agent name is rejected');
select throws_ok($$insert into public.workspaces (name) values ('')$$,
  '23514', null, 'AC2 edge: empty workspace name is rejected');

-- ---------------------------------------------------------------------------------------------
-- Security: approvals, secrets, RLS, role denial
-- ---------------------------------------------------------------------------------------------
select throws_ok($$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at) values
    ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000a2', 'x', repeat('A', 64), now())$$,
  '23514', null, 'SEC: approvals reject an upper-case hash (canonical lowercase hex only)');
select throws_ok($$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at) values
    ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000a2', 'x', repeat('a', 63), now())$$,
  '23514', null, 'SEC: approvals reject a 63-char hash');
select throws_ok($$insert into public.approvals (workspace_id, agent_id, action, payload_hash) values
    ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000a2', 'x', repeat('a', 64))$$,
  '23502', null, 'SEC: approvals require an expiry (timeout means deny)');
select col_is_null('public', 'approvals', 'consumed_at', 'SEC: consumed_at is nullable (null = unused)');
select col_type_is('public', 'approvals', 'payload_hash', 'text', 'SEC: payload_hash is text');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public'
      and column_name ~* '(secret|token_value|password|passwd|api_?key|credential|private_key|bearer|access_token|refresh_token)'),
  0, 'SEC: no secret-bearing column exists in any public table');

select is(
  (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity),
  0, 'SEC: RLS is enabled on every table');

-- anon and authenticated must be denied SELECT and INSERT on all 18 tables (42501)
create temp table qa_results (role_name text, table_name text, op text, outcome text) on commit drop;
grant all on qa_results to anon, authenticated;

do $$
declare
  r text;
  t text;
  op text;
  sql text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    for t in select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') loop
      foreach op in array array['select', 'insert'] loop
        sql := case op
                 when 'select' then format('select 1 from public.%I limit 1', t)
                 else format('insert into public.%I default values', t)
               end;
        begin
          execute format('set local role %I', r);
          execute sql;
          reset role;
          insert into qa_results values (r, t, op, 'allowed');
        exception when insufficient_privilege then
          reset role;
          insert into qa_results values (r, t, op, 'denied');
        when others then
          reset role;
          insert into qa_results values (r, t, op, 'other:' || sqlstate);
        end;
      end loop;
    end loop;
  end loop;
end $$;

select is((select count(*)::int from qa_results), 84, 'SEC: 2 roles x 21 tables x (select, insert) were attempted');
-- AGO-107: anon is denied everything (42501). authenticated may SELECT every table (membership RLS
-- filters the rows; see rls_every_table.test.sql) but a bare `insert ... default values` can never
-- succeed: it has no workspace_id, so no policy can pass it.
select is((select count(*)::int from qa_results where role_name = 'anon' and outcome = 'denied'), 42,
  'SEC: anon is denied select and insert on all 21 tables (42501)');
select is((select count(*)::int from qa_results where role_name = 'authenticated' and op = 'select' and outcome = 'allowed'), 21,
  'SEC: authenticated may select all 21 tables (rows are filtered by RLS)');
select is((select count(*)::int from qa_results where role_name = 'authenticated' and op = 'insert' and outcome = 'allowed'), 0,
  'SEC: authenticated can never insert a row without a workspace_id');

select lives_ok(
  $$set local role service_role; select count(*) from public.agents; reset role$$,
  'SEC control: service_role can still read');

-- approvals (AGO-107): anon holds nothing; authenticated may only SELECT and UPDATE the decision
-- columns (no INSERT, DELETE or table-wide UPDATE: payload_hash and expiry stay immutable)
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    where has_table_privilege('anon', 'public.approvals'::regclass, p)),
  0, 'SEC: anon holds no privilege at all on approvals');
select is(
  (select count(*)::int from unnest(array['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    where has_table_privilege('authenticated', 'public.approvals'::regclass, p))
  + (select count(*)::int from unnest(array['payload_hash', 'action', 'agent_id', 'run_id', 'expires_at', 'consumed_at', 'workspace_id', 'id']) c
    where has_column_privilege('authenticated', 'public.approvals'::regclass, c, 'UPDATE')),
  0, 'SEC: authenticated cannot insert/delete approvals or update payload_hash, action, expiry, consumption or workspace_id');

select * from finish();
rollback;
