-- AGO-96 QA (independent tester): catalog-level checks the implementer's suite does not make.
--   AC1  the four department_id columns are exactly nullable uuid with no default and no FK, each with a partial
--        index; policies has RLS enabled, exactly three policies named for command and role, and no privilege
--        beyond SELECT / INSERT(cols) / UPDATE(cols) for authenticated (TRUNCATE and REFERENCES bypass RLS,
--        so they must not be there either); anon has nothing; department_id is in no write grant.
--   AC3  rollback itself is proven by scripts/ago-96-rollback.test.mjs.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- 1. department_id: uuid, nullable, no default, on exactly the four tables (and no other table has one)
select is(
  (select array_agg(table_name::text || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none') order by table_name)
   from information_schema.columns where table_schema = 'public' and column_name = 'department_id'),
  array['agents:uuid:YES:none', 'approvals:uuid:YES:none', 'notes_index:uuid:YES:none', 'tasks:uuid:YES:none'],
  'AC1: department_id is a nullable uuid with no default on agents, approvals, notes_index and tasks only'
);

-- 2. no foreign key touches department_id yet (AGO-108 adds it with the departments table)
select is(
  (select count(*)::int from pg_constraint c
   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.contype = 'f' and a.attname = 'department_id' and c.connamespace = 'public'::regnamespace),
  0,
  'AC1: no foreign key on department_id'
);

-- 3. each hook has a partial index on (workspace_id, department_id) where department_id is not null
select is(
  (select array_agg(tablename::text order by tablename)
   from pg_indexes
   where schemaname = 'public' and indexname like '%\_workspace\_department\_idx'
     and indexdef like '%(workspace_id, department_id)%' and indexdef like '%WHERE (department_id IS NOT NULL)%'),
  array['agents', 'approvals', 'notes_index', 'tasks'],
  'AC1: a partial (workspace_id, department_id) index on each of the four tables'
);

-- 4. RLS is on for policies, and the table has exactly the three AGO-96 policies, one per command, none for delete
select ok((select relrowsecurity from pg_class where oid = 'public.policies'::regclass), 'AC1: row level security is enabled on policies');
select is(
  (select array_agg(policyname::text || ':' || cmd || ':' || array_to_string(roles, ',') order by policyname)
   from pg_policies where schemaname = 'public' and tablename = 'policies'),
  array['policies_insert_owner:INSERT:authenticated', 'policies_select_viewer:SELECT:authenticated', 'policies_update_owner:UPDATE:authenticated'],
  'AC1: exactly select / insert / update policies for authenticated, named for command and minimum role, and no delete or ALL policy'
);

-- 5. authenticated: table-level privileges are SELECT only (no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER table-wide)
select is(
  (select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege('authenticated', 'public.policies', p)),
  array['SELECT'],
  'AC1: authenticated holds only table-level SELECT on policies (TRUNCATE and DELETE would bypass or skip RLS)'
);

-- 6. exact column grants for authenticated
select is(
  (select array_agg(a.attname::text order by a.attname) from pg_attribute a
   where a.attrelid = 'public.policies'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.policies'::regclass, a.attnum, 'INSERT')),
  array['created_by', 'level', 'rule', 'scope_id', 'updated_by', 'workspace_id'],
  'AC1: authenticated can INSERT exactly workspace_id, level, scope_id, rule, created_by, updated_by'
);
select is(
  (select array_agg(a.attname::text order by a.attname) from pg_attribute a
   where a.attrelid = 'public.policies'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.policies'::regclass, a.attnum, 'UPDATE')),
  array['archived_at', 'rule', 'updated_by'],
  'AC1: authenticated can UPDATE exactly rule, archived_at, updated_by (level, scope, workspace and version are fixed)'
);

-- 7. anon has no privilege on policies at all, at table or column level
select is(
  (select count(*)::int from pg_attribute a, unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   where a.attrelid = 'public.policies'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', 'public.policies'::regclass, a.attnum, p))
  + (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     where has_table_privilege('anon', 'public.policies', p)),
  0,
  'AC1: anon has no privilege on policies'
);

-- 8. department_id is in no INSERT or UPDATE column grant of authenticated or anon, on any table
select is(
  (select count(*)::int from pg_attribute a, unnest(array['INSERT', 'UPDATE']) p, unnest(array['authenticated', 'anon']) r
   where a.attrelid in ('public.agents'::regclass, 'public.tasks'::regclass, 'public.approvals'::regclass, 'public.notes_index'::regclass)
     and a.attname = 'department_id' and not a.attisdropped
     and has_column_privilege(r, a.attrelid, a.attnum, p)),
  0,
  'AC1: department_id is writable by neither authenticated nor anon on any of the four tables'
);
select is(
  (select count(*)::int from pg_attribute a
   where a.attrelid in ('public.agents'::regclass, 'public.tasks'::regclass, 'public.approvals'::regclass, 'public.notes_index'::regclass)
     and a.attname = 'department_id' and has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')),
  4,
  'AC1: authenticated can read department_id on all four tables (membership RLS still filters rows)'
);

-- 9. the version trigger: invoker rights, not callable by the API roles, and wired BEFORE UPDATE on policies
select is(
  (select prosecdef from pg_proc where oid = 'private.bump_policy_version()'::regprocedure),
  false,
  'AC1: bump_policy_version runs as the invoker, not as its owner'
);
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r
   where has_function_privilege(r, 'private.bump_policy_version()', 'EXECUTE')),
  0,
  'AC1: neither anon nor authenticated can execute bump_policy_version directly'
);
select is(
  (select array_agg(tgname::text order by tgname) from pg_trigger
   where tgrelid = 'public.policies'::regclass and not tgisinternal and (tgtype & 2) = 2 and (tgtype & 16) = 16),
  array['bump_policy_version', 'set_updated_at'],
  'AC1: version and updated_at are maintained by BEFORE UPDATE triggers'
);

-- 10. constraints that carry the contract: scope matches level, one active policy per scope
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
   where conrelid = 'public.policies'::regclass and contype = 'c'
     and conname in ('policies_scope_matches_level')),
  array['policies_scope_matches_level'],
  'AC1: the scope-matches-level check constraint exists'
);
select is(
  (select indexdef like '%NULLS NOT DISTINCT%' and indexdef like '%WHERE (archived_at IS NULL)%'
   from pg_indexes where schemaname = 'public' and indexname = 'policies_workspace_level_scope_active_idx'),
  true,
  'AC1: the one-active-policy-per-scope index is unique over (workspace, level, scope), nulls not distinct, active rows only'
);

select * from finish();
rollback;
