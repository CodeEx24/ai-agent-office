-- AGO-89 functional tester additions (round 1). Complements agent_versions.test.sql; no overlap with its assertions.
--   AC1  a refused (stale) edit writes no version row; boundaries; the update grant is exactly the editable columns
--   AC2  the tasks guard fires on INSERT and on UPDATE OF agent_id (and not on unrelated updates); survives archive
--   AC3  duplicate of an autonomous/permissive source is strict; no argument can carry a mode; mode not grantable
--   +    viewer / member refused on all four RPCs; cross-workspace duplicate/archive/unarchive; unarchive of an
--        active agent
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

insert into auth.users (id, instance_id, aud, role, email) values
  ('8a000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89f-o@example.test'),
  ('8a000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89f-m@example.test'),
  ('8a000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89f-v@example.test'),
  ('8a000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89f-b@example.test');
insert into public.workspaces (id, name) values
  ('8aaaaaaa-0000-4000-8000-000000000001', 'AGO-89F A'),
  ('8abbbbbb-0000-4000-8000-000000000001', 'AGO-89F B');
insert into public.members (id, workspace_id, user_id, role) values
  ('8a000000-0000-4000-8000-0000000001a1', '8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-00000000000a', 'owner'),
  ('8a000000-0000-4000-8000-0000000001a2', '8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-00000000000c', 'member'),
  ('8a000000-0000-4000-8000-0000000001a3', '8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-00000000000d', 'viewer'),
  ('8a000000-0000-4000-8000-0000000001b1', '8abbbbbb-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-00000000000b', 'owner');
-- p = autonomous source, e = edit target, r = archived (for the viewer/member unarchive checks), a = active, bb = B
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents, mode, archived_at) values
  ('8a000000-0000-4000-8000-0000000002a1', '8aaaaaaa-0000-4000-8000-000000000001', 'Auto source', 'R', 'claude-haiku-5-5', 'p', 100, 'autonomous', null),
  ('8a000000-0000-4000-8000-0000000002a2', '8aaaaaaa-0000-4000-8000-000000000001', 'Edit target', 'R', 'claude-haiku-5-5', 'p', 100, 'strict', null),
  ('8a000000-0000-4000-8000-0000000002a3', '8aaaaaaa-0000-4000-8000-000000000001', 'Archived one', 'R', 'claude-haiku-5-5', 'p', 100, 'strict', now()),
  ('8a000000-0000-4000-8000-0000000002a4', '8aaaaaaa-0000-4000-8000-000000000001', 'Task target', 'R', 'claude-haiku-5-5', 'p', 100, 'strict', null),
  ('8a000000-0000-4000-8000-0000000002b1', '8abbbbbb-0000-4000-8000-000000000001', 'B agent', 'R', 'claude-haiku-5-5', 'p', 100, 'strict', null);
insert into public.tasks (id, workspace_id, title, agent_id) values
  ('8a000000-0000-4000-8000-0000000006a1', '8aaaaaaa-0000-4000-8000-000000000001', 'Loose', null),
  ('8a000000-0000-4000-8000-0000000006a2', '8aaaaaaa-0000-4000-8000-000000000001', 'Assigned to a4', '8a000000-0000-4000-8000-0000000002a4');

-- 1-6. The update and insert grants are exactly the intended column sets (checked as authenticated would see them)
select is((select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'agents' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'archived_at,daily_budget_cents,model,name,prompt,role,thinking_effort', 'update grant on agents is exactly the six settings plus archived_at');
select is((select count(*)::int from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'agents' and grantee in ('authenticated', 'anon', 'public')
              and privilege_type in ('UPDATE', 'INSERT') and column_name in ('mode', 'status', 'department_id', 'version', 'run_limits', 'id', 'workspace_id') and privilege_type = 'UPDATE'),
  0, 'mode, status, department_id, version, run_limits, id and workspace_id are not updatable by any API role');
select is((select count(*)::int from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'agents' and grantee in ('authenticated', 'anon', 'public')
              and privilege_type = 'INSERT' and column_name in ('mode', 'status', 'department_id', 'version', 'archived_at', 'run_limits')),
  0, 'mode, status, department_id, version, archived_at and run_limits are not insertable by any API role');
select is((select count(*)::int from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'agents' and grantee = 'anon'), 0, 'anon has no privilege on agents');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'duplicate_agent'
              and p.proargnames::text ~* 'mode|status|archived|version'), 0, 'duplicate_agent has no argument that could carry a mode');
select is((select string_agg(a, ',') from (select unnest(p.proargnames) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'duplicate_agent') s), 'p_workspace_id,p_agent_id,p_name', 'duplicate_agent takes only workspace, agent and name');

-- 7-9. the four RPCs are not executable by anon
select is((select count(*)::int from information_schema.routine_privileges
            where routine_schema = 'public' and grantee in ('anon', 'PUBLIC')
              and routine_name in ('update_agent', 'duplicate_agent', 'archive_agent', 'unarchive_agent')), 0, 'anon and PUBLIC cannot execute the four owner functions');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.tasks'::regclass and tgname in ('refuse_archived_assignee_insert', 'refuse_archived_assignee_update') and not tgisinternal), 2, 'both tasks guard triggers exist');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.agents'::regclass and tgname in ('bump_agent_version', 'append_agent_version') and not tgisinternal), 2, 'both agent version triggers exist');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"8a000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

-- 10-20. AC1 optimistic lock: a stale edit raises, changes nothing, writes no version row
create temp table t_before as
  select (select count(*)::int from public.agent_versions where agent_id = '8a000000-0000-4000-8000-0000000002a2') as versions,
         (select version from public.agents where id = '8a000000-0000-4000-8000-0000000002a2') as version;
grant select on t_before to authenticated;
select is((select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 1, 'Edit target', 'R2', 'claude-haiku-5-5', 'medium', 'p', 100)), 2, 'a correct expected version succeeds and returns version + 1');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 1, 'Edit target', 'STALE', 'claude-haiku-5-5', 'medium', 'p', 100)$$,
  '40001', null, 'AC1: update_agent with a stale expected version raises 40001');
select is((select role from public.agents where id = '8a000000-0000-4000-8000-0000000002a2'), 'R2', 'AC1: the stale call changed nothing (role keeps the last good value)');
select is((select count(*)::int from public.agent_versions where agent_id = '8a000000-0000-4000-8000-0000000002a2'), 2, 'AC1: the stale call wrote no version row (2 rows: create + the good edit)');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 99, 'Edit target', 'FUTURE', 'claude-haiku-5-5', 'medium', 'p', 100)$$,
  '40001', null, 'a version from the future is refused as well');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', null, 'Edit target', 'NULLV', 'claude-haiku-5-5', 'medium', 'p', 100)$$,
  '40001', null, 'a null expected version is refused (cannot skip the lock)');
select is((select version from public.agents where id = '8a000000-0000-4000-8000-0000000002a2'), 2, 'agent version unchanged after the refused calls');
select is((select array_to_string(array_agg(version order by version), ',') from public.agent_versions where agent_id = '8a000000-0000-4000-8000-0000000002a2'), '1,2', 'version numbers are contiguous');
-- boundaries
select lives_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 2, repeat('n', 120), 'R2', 'claude-haiku-5-5', 'low', 'p', 1)$$, 'a 120 character name and a budget of 1 cent are accepted');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 3, repeat('n', 121), 'R2', 'claude-haiku-5-5', 'low', 'p', 1)$$, '22023', null, 'a 121 character name is refused');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 3, 'Edit target', 'R2', 'claude-haiku-5-5', 'low', 'p', 0)$$, '22023', null, 'a zero budget is refused');
select lives_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 3, 'Edit target', 'R2', 'claude-haiku-5-5', 'high', 'p', 5000)$$, 'a budget at the cap (5000) is accepted');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 4, 'Edit target', 'R2', 'claude-haiku-5-5', 'high', repeat('x', 20001), 100)$$, '22023', null, 'a prompt over 20000 characters is refused');
select throws_ok($$select public.update_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2', 4, 'Edit target', 'R2', 'claude-haiku-5-5', null, 'p', 100)$$, '22023', null, 'a null thinking effort is refused');

-- 22-28. AC3: an autonomous source is copied as strict; the copy is a separate agent
create temp table t_copy as
  select public.duplicate_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a1', 'Auto copy') as id;
grant select on t_copy to authenticated;
select is((select mode from public.agents where id = '8a000000-0000-4000-8000-0000000002a1'), 'autonomous', 'the source really is autonomous (precondition)');
select is((select mode from public.agents where id = (select id from t_copy)), 'strict', 'AC3: a copy of an autonomous agent starts strict');
select is((select status from public.agents where id = (select id from t_copy)), 'idle', 'the copy starts idle, not running');
select is((select archived_at is null from public.agents where id = (select id from t_copy)), true, 'the copy is not archived');
select is((select version from public.agents where id = (select id from t_copy)), 1, 'the copy starts at version 1');
select isnt((select id from t_copy), '8a000000-0000-4000-8000-0000000002a1'::uuid, 'the copy has a new id');
select throws_ok($$select public.duplicate_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a1', repeat('n', 121))$$, '22023', null, 'duplicate with an over-length name is refused');
select throws_ok($$select public.duplicate_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a1', '   ')$$, '22023', null, 'duplicate with a blank name is refused');
select throws_ok($$select public.duplicate_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002b1', 'Steal B')$$, 'P0002', null, 'duplicate cannot read an agent of another workspace through my workspace');
select throws_ok($$select public.duplicate_agent('8abbbbbb-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002b1', 'Into B')$$, '42501', null, 'an owner of A cannot duplicate in workspace B');
select throws_ok($$select public.archive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002b1')$$, 'P0002', null, 'archive cannot reach an agent of another workspace');
select throws_ok($$select public.unarchive_agent('8abbbbbb-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002b1')$$, '42501', null, 'an owner of A cannot unarchive in workspace B');
select throws_ok($$select public.unarchive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2')$$, '55000', null, 'unarchive of a never-archived agent is refused');

-- AC2 guard on INSERT and UPDATE OF agent_id, with an agent archived by the RPC
select lives_ok($$select public.archive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a4')$$, 'archive the task target');
select throws_ok($$insert into public.tasks (workspace_id, title, agent_id) values ('8aaaaaaa-0000-4000-8000-000000000001', 'x', '8a000000-0000-4000-8000-0000000002a4')$$, '55000', null, 'AC2 insert guard: a new task for an archived agent is refused');
select throws_ok($$update public.tasks set agent_id = '8a000000-0000-4000-8000-0000000002a4' where id = '8a000000-0000-4000-8000-0000000006a1'$$, '55000', null, 'AC2 update guard: re-assigning a task to an archived agent is refused');
select is((select agent_id from public.tasks where id = '8a000000-0000-4000-8000-0000000006a2'), '8a000000-0000-4000-8000-0000000002a4'::uuid, 'AC2: an assignment made before the archive survives it');
select lives_ok($$update public.tasks set agent_id = null where id = '8a000000-0000-4000-8000-0000000006a2'$$, 'AC2: un-assigning a task from an archived agent is allowed');
select lives_ok($$insert into public.tasks (workspace_id, title, agent_id) values ('8aaaaaaa-0000-4000-8000-000000000001', 'unassigned', null)$$, 'a task with no agent is still accepted');
select lives_ok($$insert into public.tasks (workspace_id, title, agent_id) values ('8aaaaaaa-0000-4000-8000-000000000001', 'to active', '8a000000-0000-4000-8000-0000000002a2')$$, 'a task for an active agent is still accepted');

-- viewer and member on the four RPCs (existing file covers member update/duplicate/archive and viewer update)
select set_config('request.jwt.claims', '{"sub":"8a000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.duplicate_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a1', 'V copy')$$, '42501', null, 'a viewer cannot duplicate');
select throws_ok($$select public.archive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a2')$$, '42501', null, 'a viewer cannot archive');
select throws_ok($$select public.unarchive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a3')$$, '42501', null, 'a viewer cannot unarchive');
select set_config('request.jwt.claims', '{"sub":"8a000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.unarchive_agent('8aaaaaaa-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-0000000002a3')$$, '42501', null, 'a member cannot unarchive');
select is((select archived_at is not null from public.agents where id = '8a000000-0000-4000-8000-0000000002a3'), true, 'and the agent is still archived');

select * from finish();
rollback;
