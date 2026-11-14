-- AGO-107 QA (independent tester): catalog-level checks the implementer's suites do not make.
--   * rls_catalog only enumerates tables (relkind r, p). A view in an API schema runs as its owner,
--     so it bypasses RLS, and Supabase's default privileges hand it to anon and authenticated.
--   * the exact column-level grants of `authenticated`, restated independently from the ticket's
--     role matrix, so a widened grant (e.g. workspace_id or payload_hash becoming writable) fails.
--   * every foreign key between tenant tables carries workspace_id on both sides, so a child row
--     can never point at another workspace's parent.
--   * the only functions the API can call, and nothing reachable by anon in `private`.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- 1. No view, materialized view or foreign table in an API schema (security_invoker views are safe).
select is(
  (select coalesce(array_agg((n.nspname || '.' || c.relname)::text order by c.relname), '{}'::text[])
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'graphql_public')
     and (c.relkind in ('m', 'f') or (c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)))),
  '{}'::text[],
  'AC3: no view (without security_invoker), materialized view or foreign table in an API schema'
);

-- 2. Exact INSERT columns of authenticated.
select is(
  (select array_agg(x order by x collate "C") from (
     select t.relname || '.' || a.attname as x
     from pg_class t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
     where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
       and has_column_privilege('authenticated', t.oid, a.attnum, 'INSERT')) s),
  (select array_agg(e order by e collate "C") from unnest(array[
     'agents.workspace_id', 'agents.name', 'agents.description', 'agents.thinking_effort',
     'agents.role', 'agents.model', 'agents.prompt', 'agents.daily_budget_cents',
     'skills.workspace_id', 'skills.name', 'skills.description', 'skills.body',
     'agent_skills.workspace_id', 'agent_skills.agent_id', 'agent_skills.skill_id',
     'agent_capabilities.workspace_id', 'agent_capabilities.agent_id', 'agent_capabilities.capability',
     'agent_capabilities.tier', 'agent_capabilities.mode', 'agent_capabilities.granted_by',
     'tasks.workspace_id', 'tasks.title', 'tasks.description', 'tasks.status', 'tasks.agent_id', 'tasks.created_by',
     'runs.workspace_id', 'runs.task_id', 'runs.agent_id',
     'budgets_usage.workspace_id', 'budgets_usage.agent_id', 'budgets_usage.period_start',
     'budgets_usage.period_end', 'budgets_usage.token_budget', 'budgets_usage.cost_budget_cents',
     'notes_index.workspace_id', 'notes_index.path', 'notes_index.title', 'notes_index.content_hash', 'notes_index.metadata',
     'policies.workspace_id', 'policies.level', 'policies.scope_id', 'policies.rule', 'policies.created_by', 'policies.updated_by'
   ]) e),
  'authenticated can INSERT exactly the ticket''s columns (no id, mode, status, version, hash, usage counters)'
);

-- 3. Exact UPDATE columns of authenticated: never workspace_id, id, FKs, payload_hash, expiry, usage.
select is(
  (select array_agg(x order by x collate "C") from (
     select t.relname || '.' || a.attname as x
     from pg_class t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
     where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
       and has_column_privilege('authenticated', t.oid, a.attnum, 'UPDATE')) s),
  (select array_agg(e order by e collate "C") from unnest(array[
     'workspaces.name',
     'agents.name', 'agents.role', 'agents.model', 'agents.thinking_effort', 'agents.prompt', 'agents.daily_budget_cents', 'agents.archived_at',
     'skills.name', 'skills.description', 'skills.body',
     'tasks.title', 'tasks.description', 'tasks.status', 'tasks.agent_id',
     'approvals.status', 'approvals.decided_by', 'approvals.decided_at',
     'budgets_usage.period_end', 'budgets_usage.token_budget', 'budgets_usage.cost_budget_cents',
     'notes_index.title', 'notes_index.content_hash', 'notes_index.metadata', 'notes_index.indexed_at',
     'policies.rule', 'policies.archived_at', 'policies.updated_by',
     'capabilities.enabled', 'capabilities.description'
   ]) e),
  'authenticated can UPDATE exactly the ticket''s columns'
);

-- 4. Exact tables authenticated can DELETE from, and read.
select is(
  (select array_agg(t.relname::text order by t.relname::text collate "C")
   from pg_class t where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
     and has_table_privilege('authenticated', t.oid, 'DELETE')),
  array['agent_capabilities', 'agent_skills', 'agents', 'notes_index', 'tasks'],
  'authenticated can DELETE only from agents, agent_skills, agent_capabilities, tasks, notes_index'
);
select is(
  (select count(*)::int from pg_class t where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
     and has_any_column_privilege('authenticated', t.oid, 'SELECT')),
  21,
  'authenticated can SELECT all 21 tables (membership RLS filters the rows)'
);
select is(
  (select count(*)::int from pg_class t where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
     and not has_table_privilege('service_role', t.oid, 'SELECT,INSERT,UPDATE,DELETE')),
  0,
  'service_role (the runtime) keeps full DML on every table'
);

-- 5. Foreign keys between tenant tables are composite on workspace_id, on both sides.
select is(
  (select coalesce(array_agg((child.relname || '.' || k.conname)::text order by k.conname), '{}'::text[])
   from pg_constraint k
   join pg_class child on child.oid = k.conrelid
   join pg_class parent on parent.oid = k.confrelid
   where k.contype = 'f'
     and child.relnamespace = 'public'::regnamespace and parent.relnamespace = 'public'::regnamespace
     and parent.relname <> 'workspaces'
     and not (
       exists (select 1 from pg_attribute a where a.attrelid = child.oid and a.attname = 'workspace_id' and a.attnum = any (k.conkey))
       and exists (select 1 from pg_attribute a where a.attrelid = parent.oid and a.attname = 'workspace_id' and a.attnum = any (k.confkey))
     )),
  '{}'::text[],
  'every FK between tenant tables includes workspace_id on both sides (no cross-workspace parent)'
);

-- 6. Functions: the API can call exactly one RPC; anon reaches nothing in public or private.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname::text), '{}'::text[]) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  array['archive_agent', 'create_agent', 'duplicate_agent', 'onboard_current_user', 'record_pack_export', 'request_run_control', 'set_agent_run_limits', 'unarchive_agent', 'update_agent'],
  'authenticated can execute exactly nine functions in public: create_agent (AGO-141), set_agent_run_limits (AGO-166), update_agent, duplicate_agent, archive_agent, unarchive_agent (AGO-89), all owner-checked, record_pack_export (AGO-192) and request_run_control (AGO-86), both member-checked, and onboard_current_user'
);
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname::text), '{}'::text[]) from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
     and has_function_privilege('anon', p.oid, 'EXECUTE')),
  '{}'::text[],
  'anon can execute no function in public or private'
);
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname::text), '{}'::text[]) from pg_proc p
   where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array['current_member_id', 'is_member', 'run_limits_valid'],
  'authenticated can execute only the two RLS helpers and run_limits_valid (AGO-166, the agents.run_limits CHECK) in private'
);
select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'anon has no USAGE on schema private');

-- 7. Nothing leaks through sequences or realtime.
select is(
  (select count(*)::int from pg_class s
   where s.relnamespace = 'public'::regnamespace and s.relkind = 'S'
     and (has_sequence_privilege('anon', s.oid, 'USAGE,SELECT,UPDATE') or has_sequence_privilege('authenticated', s.oid, 'USAGE,SELECT,UPDATE'))),
  0,
  'anon and authenticated hold no privilege on any sequence in public'
);

select * from finish();
rollback;
