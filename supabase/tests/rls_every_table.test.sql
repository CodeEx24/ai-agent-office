-- AGO-107 AC1 + AC2: user A cannot see user B's rows in ANY table, and select/insert/update/delete
-- are exercised on EVERY table for every role (owner, member, viewer, removed member, and an outsider
-- who owns another workspace). Each attempt runs inside a rolled-back subtransaction, so every
-- principal sees the same data. The expected matrix below is the documented role matrix
-- (docs/database.md); a table missing from the cases fails the coverage assertions.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

-- ids: 10700000-0000-4000-8000-00000000 || table(2) || workspace(a|b|c) || n
-- tables: 00 workspaces/users, 01 members, 02 agents, 03 skills, 04 agent_skills, 05 agent_capabilities,
--         06 tasks, 07 runs, 08 run_events, 09 approvals, 10 claims, 11 budgets_usage, 12 notes_index
-- a = workspace A main rows, c = spare rows in A that may be deleted, b = workspace B rows
insert into auth.users (id, instance_id, aud, role, email) values
  ('10700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago107-owner@example.test'),
  ('10700000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago107-member@example.test'),
  ('10700000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago107-viewer@example.test'),
  ('10700000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago107-removed@example.test'),
  ('10700000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago107-b-owner@example.test');
insert into public.workspaces (id, name) values
  ('10700000-0000-4000-8000-0000000000a1', 'AGO-107 A'),
  ('10700000-0000-4000-8000-0000000000b1', 'AGO-107 B');
insert into public.members (id, workspace_id, user_id, role, removed_at) values
  ('10700000-0000-4000-8000-0000000001a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-000000000001', 'owner', null),
  ('10700000-0000-4000-8000-0000000001a2', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-000000000002', 'member', null),
  ('10700000-0000-4000-8000-0000000001a3', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-000000000003', 'viewer', null),
  ('10700000-0000-4000-8000-0000000001a4', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-000000000004', 'member', now()),
  ('10700000-0000-4000-8000-0000000001b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-000000000005', 'owner', null);
insert into public.agents (id, workspace_id, name) values
  ('10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000000a1', 'agent-a'),
  ('10700000-0000-4000-8000-0000000002c1', '10700000-0000-4000-8000-0000000000a1', 'agent-spare'),
  ('10700000-0000-4000-8000-0000000002b1', '10700000-0000-4000-8000-0000000000b1', 'agent-b');
insert into public.skills (id, workspace_id, name) values
  ('10700000-0000-4000-8000-0000000003a1', '10700000-0000-4000-8000-0000000000a1', 'skill-a'),
  ('10700000-0000-4000-8000-0000000003c1', '10700000-0000-4000-8000-0000000000a1', 'skill-spare'),
  ('10700000-0000-4000-8000-0000000003b1', '10700000-0000-4000-8000-0000000000b1', 'skill-b');
insert into public.agent_skills (id, workspace_id, agent_id, skill_id) values
  ('10700000-0000-4000-8000-0000000004a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000003a1'),
  ('10700000-0000-4000-8000-0000000004c1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002c1', '10700000-0000-4000-8000-0000000003c1'),
  ('10700000-0000-4000-8000-0000000004b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000002b1', '10700000-0000-4000-8000-0000000003b1');
insert into public.agent_capabilities (id, workspace_id, agent_id, capability, granted_by) values
  ('10700000-0000-4000-8000-0000000005a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', 'read_notes', '10700000-0000-4000-8000-0000000001a1'),
  ('10700000-0000-4000-8000-0000000005c1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', 'spare_cap', '10700000-0000-4000-8000-0000000001a1'),
  ('10700000-0000-4000-8000-0000000005b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000002b1', 'read_notes', '10700000-0000-4000-8000-0000000001b1');
insert into public.tasks (id, workspace_id, title, agent_id, created_by) values
  ('10700000-0000-4000-8000-0000000006a1', '10700000-0000-4000-8000-0000000000a1', 'task-a', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000001a1'),
  ('10700000-0000-4000-8000-0000000006c1', '10700000-0000-4000-8000-0000000000a1', 'task-spare', null, null),
  ('10700000-0000-4000-8000-0000000006b1', '10700000-0000-4000-8000-0000000000b1', 'task-b', '10700000-0000-4000-8000-0000000002b1', '10700000-0000-4000-8000-0000000001b1');
insert into public.runs (id, workspace_id, task_id, agent_id) values
  ('10700000-0000-4000-8000-0000000007a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000006a1', '10700000-0000-4000-8000-0000000002a1'),
  ('10700000-0000-4000-8000-0000000007b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000006b1', '10700000-0000-4000-8000-0000000002b1');
insert into public.agent_credentials (id, workspace_id, agent_id, run_id, token_hash, capabilities, issued_at, expires_at) values
  ('10700000-0000-4000-8000-0000000014a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000007a1', repeat('a', 64), '{}', now(), now() + interval '10 minutes'),
  ('10700000-0000-4000-8000-0000000014b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000002b1', '10700000-0000-4000-8000-0000000007b1', repeat('b', 64), '{}', now(), now() + interval '10 minutes');
insert into public.run_events (id, workspace_id, run_id, type) values
  ('10700000-0000-4000-8000-0000000008a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', 'run.started'),
  ('10700000-0000-4000-8000-0000000008b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000007b1', 'run.started');
insert into public.approvals (id, workspace_id, run_id, agent_id, action, payload_hash, expires_at) values
  ('10700000-0000-4000-8000-0000000009a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', '10700000-0000-4000-8000-0000000002a1', 'send_email', repeat('a', 64), now() + interval '1 hour'),
  ('10700000-0000-4000-8000-0000000009c1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', '10700000-0000-4000-8000-0000000002a1', 'send_email', repeat('c', 64), now() - interval '1 minute'),
  ('10700000-0000-4000-8000-0000000009b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000007b1', '10700000-0000-4000-8000-0000000002b1', 'send_email', repeat('b', 64), now() + interval '1 hour');
insert into public.claims (id, workspace_id, task_id, agent_id, run_id) values
  ('10700000-0000-4000-8000-0000000010a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000006a1', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000007a1'),
  ('10700000-0000-4000-8000-0000000010b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000006b1', '10700000-0000-4000-8000-0000000002b1', '10700000-0000-4000-8000-0000000007b1');
insert into public.budgets_usage (id, workspace_id, agent_id, period_start, period_end) values
  ('10700000-0000-4000-8000-0000000011a1', '10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', '2026-11-01', '2026-12-01'),
  ('10700000-0000-4000-8000-0000000011b1', '10700000-0000-4000-8000-0000000000b1', '10700000-0000-4000-8000-0000000002b1', '2026-11-01', '2026-12-01');
insert into public.notes_index (id, workspace_id, path) values
  ('10700000-0000-4000-8000-0000000012a1', '10700000-0000-4000-8000-0000000000a1', 'a.md'),
  ('10700000-0000-4000-8000-0000000012c1', '10700000-0000-4000-8000-0000000000a1', 'spare.md'),
  ('10700000-0000-4000-8000-0000000012b1', '10700000-0000-4000-8000-0000000000b1', 'b.md');
-- 13 policies (AGO-96): a baseline policy and a department-level policy in A, a baseline in B
insert into public.policies (id, workspace_id, level, scope_id, rule, created_by, updated_by) values
  ('10700000-0000-4000-8000-0000000013a1', '10700000-0000-4000-8000-0000000000a1', 'baseline', null, '{"version":1,"rules":[]}', '10700000-0000-4000-8000-0000000001a1', '10700000-0000-4000-8000-0000000001a1'),
  ('10700000-0000-4000-8000-0000000013c1', '10700000-0000-4000-8000-0000000000a1', 'department', '10700000-0000-4000-8000-0000000014a1', '{"version":1,"rules":[]}', '10700000-0000-4000-8000-0000000001a1', '10700000-0000-4000-8000-0000000001a1'),
  ('10700000-0000-4000-8000-0000000013b1', '10700000-0000-4000-8000-0000000000b1', 'baseline', null, '{"version":1,"rules":[]}', '10700000-0000-4000-8000-0000000001b1', '10700000-0000-4000-8000-0000000001b1');

-- test harness (rolled back with the transaction)
create schema ago107_t;
grant usage on schema ago107_t to authenticated, anon, service_role;

-- Runs one statement, reports what happened and always rolls it back.
--   rows:N  = the statement ran and touched N rows;  error:SQLSTATE = it raised
create function ago107_t.attempt(p_sql text) returns text language plpgsql as $f$
declare
  n bigint;
  d text;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception 'rollback' using errcode = 'P0099', detail = n::text;
  exception
    when sqlstate 'P0099' then
      get stacked diagnostics d = pg_exception_detail;
      return 'rows:' || d;
    when others then
      return 'error:' || sqlstate;
  end;
end;
$f$;
grant execute on function ago107_t.attempt(text) to authenticated;

-- AC1 helper: for every table in public, how many rows of workspace p_ws and how many of any other
-- workspace the caller can see. Dynamic, so a table added later is included automatically.
create function ago107_t.visibility(p_ws uuid) returns table (tbl text, own bigint, foreign_rows bigint)
language plpgsql as $f$
declare
  r record;
  col text;
begin
  for r in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by c.relname loop
    col := case when r.relname = 'workspaces' then 'id' else 'workspace_id' end;
    tbl := r.relname;
    execute format('select count(*) filter (where %1$I = $1), count(*) filter (where %1$I <> $1) from public.%2$I', col, r.relname)
      into own, foreign_rows using p_ws;
    return next;
  end loop;
end;
$f$;
grant execute on function ago107_t.visibility(uuid) to authenticated;

create table ago107_t.principals (name text primary key, user_id uuid not null, rank int not null);
insert into ago107_t.principals values
  ('owner',    '10700000-0000-4000-8000-000000000001', 3),
  ('member',   '10700000-0000-4000-8000-000000000002', 2),
  ('viewer',   '10700000-0000-4000-8000-000000000003', 1),
  ('removed',  '10700000-0000-4000-8000-000000000004', 0),   -- soft-removed member of A
  ('outsider', '10700000-0000-4000-8000-000000000005', 0);   -- owner of workspace B, attacking A

-- Role matrix: minimum role that may run the command (null = nobody through the API).
create table ago107_t.expected (tbl text, cmd text, min_rank int, primary key (tbl, cmd));
insert into ago107_t.expected values
  ('workspaces', 'select', 1), ('workspaces', 'insert', null), ('workspaces', 'update', 3), ('workspaces', 'delete', null),
  ('members', 'select', 1), ('members', 'insert', null), ('members', 'update', null), ('members', 'delete', null),
  ('agents', 'select', 1), ('agents', 'insert', 3), ('agents', 'update', 2), ('agents', 'delete', 3),
  ('skills', 'select', 1), ('skills', 'insert', 3), ('skills', 'update', 3), ('skills', 'delete', null),
  ('skill_versions', 'select', 1), ('skill_versions', 'insert', null), ('skill_versions', 'update', null), ('skill_versions', 'delete', null),
  ('agent_skills', 'select', 1), ('agent_skills', 'insert', 3), ('agent_skills', 'update', null), ('agent_skills', 'delete', 3),
  ('agent_capabilities', 'select', 1), ('agent_capabilities', 'insert', 3), ('agent_capabilities', 'update', null), ('agent_capabilities', 'delete', 3),
  ('tasks', 'select', 1), ('tasks', 'insert', 2), ('tasks', 'update', 2), ('tasks', 'delete', 2),
  ('runs', 'select', 1), ('runs', 'insert', 2), ('runs', 'update', null), ('runs', 'delete', null),
  ('run_events', 'select', 1), ('run_events', 'insert', null), ('run_events', 'update', null), ('run_events', 'delete', null),
  ('approvals', 'select', 1), ('approvals', 'insert', null), ('approvals', 'update', 2), ('approvals', 'delete', null),
  ('claims', 'select', 1), ('claims', 'insert', null), ('claims', 'update', null), ('claims', 'delete', null),
  ('budgets_usage', 'select', 1), ('budgets_usage', 'insert', 3), ('budgets_usage', 'update', 3), ('budgets_usage', 'delete', null),
  ('notes_index', 'select', 1), ('notes_index', 'insert', 2), ('notes_index', 'update', 2), ('notes_index', 'delete', 2),
  ('policies', 'select', 1), ('policies', 'insert', 3), ('policies', 'update', 3), ('policies', 'delete', null),
  ('capabilities', 'select', 1), ('capabilities', 'insert', null), ('capabilities', 'update', 3), ('capabilities', 'delete', null),
  ('agent_identities', 'select', 1), ('agent_identities', 'insert', null), ('agent_identities', 'update', null), ('agent_identities', 'delete', null),
  ('agent_credentials', 'select', 1), ('agent_credentials', 'insert', null), ('agent_credentials', 'update', null), ('agent_credentials', 'delete', null);

-- One statement per table and command, always aimed at workspace A (the outsider is the attacker).
create table ago107_t.cases (tbl text, cmd text, stmt text, primary key (tbl, cmd));
insert into ago107_t.cases values
  ('workspaces', 'select', $q$select 1 from public.workspaces where id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('workspaces', 'insert', $q$insert into public.workspaces (name) values ('probe')$q$),
  ('workspaces', 'update', $q$update public.workspaces set name = 'renamed' where id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('workspaces', 'delete', $q$delete from public.workspaces where id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('members', 'select', $q$select 1 from public.members where id = '10700000-0000-4000-8000-0000000001a1'$q$),
  ('members', 'insert', $q$insert into public.members (workspace_id, user_id, role) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-000000000005', 'member')$q$),
  ('members', 'update', $q$update public.members set role = 'owner' where id = '10700000-0000-4000-8000-0000000001a2'$q$),
  ('members', 'delete', $q$delete from public.members where id = '10700000-0000-4000-8000-0000000001a3'$q$),
  ('agents', 'select', $q$select 1 from public.agents where id = '10700000-0000-4000-8000-0000000002a1'$q$),
  ('agents', 'insert', $q$insert into public.agents (workspace_id, name) values ('10700000-0000-4000-8000-0000000000a1', 'probe-agent')$q$),
  ('agents', 'update', $q$update public.agents set description = 'edited' where id = '10700000-0000-4000-8000-0000000002a1'$q$),
  ('agents', 'delete', $q$delete from public.agents where id = '10700000-0000-4000-8000-0000000002c1'$q$),
  ('skills', 'select', $q$select 1 from public.skills where id = '10700000-0000-4000-8000-0000000003a1'$q$),
  ('skills', 'insert', $q$insert into public.skills (workspace_id, name, body) values ('10700000-0000-4000-8000-0000000000a1', 'probe-skill', 'x')$q$),
  ('skills', 'update', $q$update public.skills set body = 'edited' where id = '10700000-0000-4000-8000-0000000003a1'$q$),
  ('skills', 'delete', $q$delete from public.skills where id = '10700000-0000-4000-8000-0000000003c1'$q$),
  ('skill_versions', 'select', $q$select 1 from public.skill_versions where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('skill_versions', 'insert', $q$insert into public.skill_versions (workspace_id, skill_id, version, body) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000003a1', 99, 'x')$q$),
  ('skill_versions', 'update', $q$update public.skill_versions set body = 'tampered' where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('skill_versions', 'delete', $q$delete from public.skill_versions where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('agent_skills', 'select', $q$select 1 from public.agent_skills where id = '10700000-0000-4000-8000-0000000004a1'$q$),
  ('agent_skills', 'insert', $q$insert into public.agent_skills (workspace_id, agent_id, skill_id) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000003c1')$q$),
  ('agent_skills', 'update', $q$update public.agent_skills set skill_id = '10700000-0000-4000-8000-0000000003c1' where id = '10700000-0000-4000-8000-0000000004a1'$q$),
  ('agent_skills', 'delete', $q$delete from public.agent_skills where id = '10700000-0000-4000-8000-0000000004c1'$q$),
  ('agent_capabilities', 'select', $q$select 1 from public.agent_capabilities where id = '10700000-0000-4000-8000-0000000005a1'$q$),
  ('agent_capabilities', 'insert', $q$insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, granted_by) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', 'probe_cap', 1, (select m.id from public.members m where m.workspace_id = '10700000-0000-4000-8000-0000000000a1' and m.user_id = (select auth.uid())))$q$),
  ('agent_capabilities', 'update', $q$update public.agent_capabilities set tier = 0 where id = '10700000-0000-4000-8000-0000000005a1'$q$),
  ('agent_capabilities', 'delete', $q$delete from public.agent_capabilities where id = '10700000-0000-4000-8000-0000000005c1'$q$),
  ('tasks', 'select', $q$select 1 from public.tasks where id = '10700000-0000-4000-8000-0000000006a1'$q$),
  ('tasks', 'insert', $q$insert into public.tasks (workspace_id, title) values ('10700000-0000-4000-8000-0000000000a1', 'probe-task')$q$),
  ('tasks', 'update', $q$update public.tasks set title = 'edited' where id = '10700000-0000-4000-8000-0000000006a1'$q$),
  ('tasks', 'delete', $q$delete from public.tasks where id = '10700000-0000-4000-8000-0000000006c1'$q$),
  ('runs', 'select', $q$select 1 from public.runs where id = '10700000-0000-4000-8000-0000000007a1'$q$),
  ('runs', 'insert', $q$insert into public.runs (workspace_id, task_id, agent_id) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000006a1', '10700000-0000-4000-8000-0000000002a1')$q$),
  ('runs', 'update', $q$update public.runs set status = 'running' where id = '10700000-0000-4000-8000-0000000007a1'$q$),
  ('runs', 'delete', $q$delete from public.runs where id = '10700000-0000-4000-8000-0000000007a1'$q$),
  ('run_events', 'select', $q$select 1 from public.run_events where id = '10700000-0000-4000-8000-0000000008a1'$q$),
  ('run_events', 'insert', $q$insert into public.run_events (workspace_id, run_id, type) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', 'probe')$q$),
  ('run_events', 'update', $q$update public.run_events set type = 'tampered' where id = '10700000-0000-4000-8000-0000000008a1'$q$),
  ('run_events', 'delete', $q$delete from public.run_events where id = '10700000-0000-4000-8000-0000000008a1'$q$),
  ('approvals', 'select', $q$select 1 from public.approvals where id = '10700000-0000-4000-8000-0000000009a1'$q$),
  ('approvals', 'insert', $q$insert into public.approvals (workspace_id, agent_id, action, payload_hash, expires_at) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', 'x', repeat('d', 64), now() + interval '1 hour')$q$),
  ('approvals', 'update', $q$update public.approvals set status = 'approved', decided_at = now(), decided_by = (select m.id from public.members m where m.workspace_id = '10700000-0000-4000-8000-0000000000a1' and m.user_id = (select auth.uid())) where id = '10700000-0000-4000-8000-0000000009a1'$q$),
  ('approvals', 'delete', $q$delete from public.approvals where id = '10700000-0000-4000-8000-0000000009a1'$q$),
  ('claims', 'select', $q$select 1 from public.claims where id = '10700000-0000-4000-8000-0000000010a1'$q$),
  ('claims', 'insert', $q$insert into public.claims (workspace_id, task_id, agent_id) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000006c1', '10700000-0000-4000-8000-0000000002a1')$q$),
  ('claims', 'update', $q$update public.claims set released_at = now() where id = '10700000-0000-4000-8000-0000000010a1'$q$),
  ('claims', 'delete', $q$delete from public.claims where id = '10700000-0000-4000-8000-0000000010a1'$q$),
  ('budgets_usage', 'select', $q$select 1 from public.budgets_usage where id = '10700000-0000-4000-8000-0000000011a1'$q$),
  ('budgets_usage', 'insert', $q$insert into public.budgets_usage (workspace_id, agent_id, period_start, period_end, token_budget) values ('10700000-0000-4000-8000-0000000000a1', null, '2026-12-01', '2027-01-01', 1000)$q$),
  ('budgets_usage', 'update', $q$update public.budgets_usage set token_budget = 5 where id = '10700000-0000-4000-8000-0000000011a1'$q$),
  ('budgets_usage', 'delete', $q$delete from public.budgets_usage where id = '10700000-0000-4000-8000-0000000011a1'$q$),
  ('notes_index', 'select', $q$select 1 from public.notes_index where id = '10700000-0000-4000-8000-0000000012a1'$q$),
  ('notes_index', 'insert', $q$insert into public.notes_index (workspace_id, path) values ('10700000-0000-4000-8000-0000000000a1', 'probe.md')$q$),
  ('notes_index', 'update', $q$update public.notes_index set title = 'edited' where id = '10700000-0000-4000-8000-0000000012a1'$q$),
  ('notes_index', 'delete', $q$delete from public.notes_index where id = '10700000-0000-4000-8000-0000000012c1'$q$),
  ('policies', 'select', $q$select 1 from public.policies where id = '10700000-0000-4000-8000-0000000013a1'$q$),
  ('policies', 'insert', $q$insert into public.policies (workspace_id, level, scope_id, rule, created_by, updated_by) values ('10700000-0000-4000-8000-0000000000a1', 'team', '10700000-0000-4000-8000-0000000015a1', '{"version":1,"rules":[]}', (select m.id from public.members m where m.workspace_id = '10700000-0000-4000-8000-0000000000a1' and m.user_id = (select auth.uid())), (select m.id from public.members m where m.workspace_id = '10700000-0000-4000-8000-0000000000a1' and m.user_id = (select auth.uid())))$q$),
  ('policies', 'update', $q$update public.policies set rule = '{"version":1,"rules":[{"action":"x","effect":"deny"}]}', updated_by = (select m.id from public.members m where m.workspace_id = '10700000-0000-4000-8000-0000000000a1' and m.user_id = (select auth.uid())) where id = '10700000-0000-4000-8000-0000000013a1'$q$),
  ('policies', 'delete', $q$delete from public.policies where id = '10700000-0000-4000-8000-0000000013c1'$q$),
  ('capabilities', 'select', $q$select 1 from public.capabilities where workspace_id = '10700000-0000-4000-8000-0000000000a1' and key = 'vault.read'$q$),
  ('capabilities', 'insert', $q$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode) values ('10700000-0000-4000-8000-0000000000a1', 'probe.cap', 'Probe', 0, 'agent', 'automatic')$q$),
  ('capabilities', 'update', $q$update public.capabilities set description = 'edited' where workspace_id = '10700000-0000-4000-8000-0000000000a1' and key = 'vault.read'$q$),
  ('capabilities', 'delete', $q$delete from public.capabilities where workspace_id = '10700000-0000-4000-8000-0000000000a1' and key = 'vault.read'$q$),
  ('agent_identities', 'select', $q$select 1 from public.agent_identities where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('agent_identities', 'insert', $q$insert into public.agent_identities (workspace_id, agent_id) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002c1')$q$),
  ('agent_identities', 'update', $q$update public.agent_identities set created_at = now() where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('agent_identities', 'delete', $q$delete from public.agent_identities where workspace_id = '10700000-0000-4000-8000-0000000000a1'$q$),
  ('agent_credentials', 'select', $q$select 1 from public.agent_credentials where id = '10700000-0000-4000-8000-0000000014a1'$q$),
  ('agent_credentials', 'insert', $q$insert into public.agent_credentials (workspace_id, agent_id, run_id, token_hash, capabilities, expires_at) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', '10700000-0000-4000-8000-0000000007a1', repeat('e', 64), '{}', now() + interval '5 minutes')$q$),
  ('agent_credentials', 'update', $q$update public.agent_credentials set revoked_at = now() where id = '10700000-0000-4000-8000-0000000014a1'$q$),
  ('agent_credentials', 'delete', $q$delete from public.agent_credentials where id = '10700000-0000-4000-8000-0000000014a1'$q$);

create table ago107_t.results (principal text, tbl text, cmd text, outcome text);
grant select on ago107_t.cases, ago107_t.principals to authenticated;
grant insert on ago107_t.results to authenticated;

-- 1-4. coverage: every table in public, every command, every principal
select is_empty(
  $$select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and not exists (select 1 from ago107_t.cases k where k.tbl = c.relname)$$,
  'AC2: every table in public has test cases (add a row to cases and expected for a new table)');
select is_empty(
  $$select t.tbl from (select tbl, count(distinct cmd) n from ago107_t.cases group by tbl) t where t.n <> 4$$,
  'AC2: every table is exercised with select, insert, update and delete');
select is((select count(*)::int from ago107_t.cases), 72, 'AC2: 18 tables x 4 commands = 72 cases');
select is((select count(*)::int from ago107_t.cases c join ago107_t.expected e using (tbl, cmd)), 72, 'AC2: every case has a documented expectation');

-- run the 72 cases as each principal
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into ago107_t.results select 'owner', tbl, cmd, ago107_t.attempt(stmt) from ago107_t.cases;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000002","role":"authenticated"}', true);
insert into ago107_t.results select 'member', tbl, cmd, ago107_t.attempt(stmt) from ago107_t.cases;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000003","role":"authenticated"}', true);
insert into ago107_t.results select 'viewer', tbl, cmd, ago107_t.attempt(stmt) from ago107_t.cases;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000004","role":"authenticated"}', true);
insert into ago107_t.results select 'removed', tbl, cmd, ago107_t.attempt(stmt) from ago107_t.cases;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000005","role":"authenticated"}', true);
insert into ago107_t.results select 'outsider', tbl, cmd, ago107_t.attempt(stmt) from ago107_t.cases;
reset role;

-- 5-7. the matrix: actual outcome equals the documented one for every principal, table and command
select is((select count(*)::int from ago107_t.results), 360, 'AC2: 5 principals x 72 cases were attempted');
create view ago107_t.mismatches as
  select r.principal, r.tbl, r.cmd, r.outcome,
         case when e.min_rank is not null and p.rank >= e.min_rank then 'allowed' else 'denied' end as expected
  from ago107_t.results r
  join ago107_t.principals p on p.name = r.principal
  join ago107_t.expected e on e.tbl = r.tbl and e.cmd = r.cmd
  where case when r.outcome ~ '^rows:[1-9]' then 'allowed'
             when r.outcome in ('rows:0', 'error:42501') then 'denied'
             else 'unexpected:' || r.outcome end
        <> case when e.min_rank is not null and p.rank >= e.min_rank then 'allowed' else 'denied' end;
select is_empty($$select * from ago107_t.mismatches$$,
  'AC2: select/insert/update/delete on every table behaves exactly as the role matrix says, for owner, member, viewer, removed and outsider');
select is((select count(*)::int from ago107_t.results r join ago107_t.principals p on p.name = r.principal
            join ago107_t.expected e on e.tbl = r.tbl and e.cmd = r.cmd
            where r.outcome ~ '^rows:[1-9]'),
          (select count(*)::int from ago107_t.principals p join ago107_t.expected e on e.min_rank is not null and p.rank >= e.min_rank),
  'the matrix is not vacuous: every allowed cell really touched a row');
select is((select count(*)::int from ago107_t.results where principal in ('removed', 'outsider') and outcome ~ '^rows:[1-9]'), 0,
  'AC1: a removed member and a member of another workspace could not read or change anything in workspace A');

-- 8-12. AC1, dynamic: every table, own rows visible, no foreign rows
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is_empty($$select * from ago107_t.visibility('10700000-0000-4000-8000-0000000000a1') where foreign_rows <> 0 or own = 0$$,
  'AC1: owner of A sees A''s rows in all 18 tables and no row of B');
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is_empty($$select * from ago107_t.visibility('10700000-0000-4000-8000-0000000000a1') where foreign_rows <> 0 or own = 0$$,
  'AC1: member of A sees A''s rows in all 18 tables and no row of B');
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is_empty($$select * from ago107_t.visibility('10700000-0000-4000-8000-0000000000a1') where foreign_rows <> 0 or own = 0$$,
  'AC1: viewer of A sees A''s rows in all 18 tables and no row of B');
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select is_empty($$select * from ago107_t.visibility('10700000-0000-4000-8000-0000000000b1') where foreign_rows <> 0 or own = 0$$,
  'AC1: owner of B sees B''s rows in all 18 tables and no row of A');
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select coalesce(sum(own + foreign_rows), 0)::int from ago107_t.visibility('10700000-0000-4000-8000-0000000000a1')), 0,
  'AC1: a soft-removed member sees zero rows in every table');
reset role;

-- 13-. targeted security cases. Roles are set per block; every statement is rolled back or pinned.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$insert into public.tasks (workspace_id, title) values ('10700000-0000-4000-8000-0000000000b1', 'smuggled')$$,
  '42501', null, 'a member of A cannot insert a task into workspace B');
select throws_ok($$update public.tasks set workspace_id = '10700000-0000-4000-8000-0000000000b1' where id = '10700000-0000-4000-8000-0000000006a1'$$,
  '42501', null, 'a member cannot move a row to another workspace (workspace_id is not updatable)');
select throws_ok($$insert into public.tasks (workspace_id, title, created_by) values ('10700000-0000-4000-8000-0000000000a1', 'forged', '10700000-0000-4000-8000-0000000001a1')$$,
  '42501', null, 'a member cannot attribute a task to another member');
select lives_ok($$insert into public.tasks (workspace_id, title, created_by) values ('10700000-0000-4000-8000-0000000000a1', 'mine', '10700000-0000-4000-8000-0000000001a2')$$,
  'a member can create a task attributed to themselves');
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('10700000-0000-4000-8000-0000000000a1', 'loose', 'permissive')$$,
  '42501', null, 'nobody can pick an agent mode through the API (agents always start strict)');
select throws_ok($$update public.agents set mode = 'permissive' where id = '10700000-0000-4000-8000-0000000002a1'$$,
  '42501', null, 'nobody can loosen an agent''s mode through the API');
select throws_ok($$update public.members set role = 'owner' where user_id = '10700000-0000-4000-8000-000000000002'$$,
  '42501', null, 'a member cannot promote themselves');
select throws_ok($$insert into public.run_events (workspace_id, run_id, type) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', 'forged')$$,
  '42501', null, 'a member cannot forge a run event');
select throws_ok($$update public.approvals set payload_hash = repeat('f', 64) where id = '10700000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'approvals stay bound to their payload hash (column not updatable)');
select throws_ok($$update public.approvals set expires_at = now() + interval '1 year' where id = '10700000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'an approval''s expiry cannot be extended');
select throws_ok($$update public.approvals set consumed_at = null where id = '10700000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'single use: consumed_at cannot be reset through the API');
select throws_ok($$update public.approvals set status = 'approved', decided_by = '10700000-0000-4000-8000-0000000001a1', decided_at = now() where id = '10700000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'a member cannot record someone else as the approver');
select throws_ok($$update public.approvals set status = 'pending', decided_by = '10700000-0000-4000-8000-0000000001a2', decided_at = now() where id = '10700000-0000-4000-8000-0000000009a1'$$,
  '42501', null, 'a decision can only be approved or denied');
select is((select outcome from (select ago107_t.attempt($q$update public.approvals set status = 'approved', decided_by = '10700000-0000-4000-8000-0000000001a2', decided_at = now() where id = '10700000-0000-4000-8000-0000000009c1'$q$) as outcome) x),
  'rows:0', 'an expired approval can no longer be approved (timeout means deny)');
select is((select outcome from (select ago107_t.attempt($q$update public.approvals set status = 'approved', decided_by = '10700000-0000-4000-8000-0000000001a2', decided_at = now() where id = '10700000-0000-4000-8000-0000000009a1'$q$) as outcome) x),
  'rows:1', 'a member can approve a pending, unexpired approval as themselves');
select throws_ok($$update public.budgets_usage set tokens_used = 0 where id = '10700000-0000-4000-8000-0000000011a1'$$,
  '42501', null, 'usage counters are not writable through the API');
select throws_ok($$delete from public.run_events$$, '42501', null, 'run_events cannot be deleted through the API');

select set_config('request.jwt.claims', '{"sub":"10700000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$insert into public.agent_capabilities (workspace_id, agent_id, capability, granted_by) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000002a1', 'forged_grant', '10700000-0000-4000-8000-0000000001a2')$$,
  '42501', null, 'an owner cannot record another member as the grantor of a capability');
select is(private.current_member_id('10700000-0000-4000-8000-0000000000a1'), '10700000-0000-4000-8000-0000000001a1'::uuid,
  'current_member_id returns the caller''s own membership id');
select is(private.current_member_id('10700000-0000-4000-8000-0000000000b1'), null,
  'current_member_id is null for a workspace the caller does not belong to');
select throws_ok($$insert into public.budgets_usage (workspace_id, period_start, period_end, tokens_used) values ('10700000-0000-4000-8000-0000000000a1', '2027-01-01', '2027-02-01', 999)$$,
  '42501', null, 'an owner cannot seed usage counters');
reset role;

-- anon: no function, no table
set local role anon;
select throws_ok($$select private.current_member_id('10700000-0000-4000-8000-0000000000a1')$$, '42501', null, 'anon cannot call the membership helper');
select throws_ok($$select 1 from public.tasks$$, '42501', null, 'anon cannot read tasks');
reset role;

-- the runtime (service_role) is unaffected by the policies: it still writes events and settles approvals
select lives_ok($$set local role service_role; insert into public.run_events (workspace_id, run_id, type) values ('10700000-0000-4000-8000-0000000000a1', '10700000-0000-4000-8000-0000000007a1', 'run.step'); reset role$$,
  'service_role (the runtime) can still append run events');
select is((select max(seq) from public.run_events where run_id = '10700000-0000-4000-8000-0000000007a1'), 2::bigint,
  'the per-run sequence still advances when a policy-bound role is also in play');
select lives_ok($$set local role service_role; update public.approvals set consumed_at = now() where id = '10700000-0000-4000-8000-0000000009a1'; reset role$$,
  'service_role (the runtime) can consume an approval');

select * from finish();
rollback;
