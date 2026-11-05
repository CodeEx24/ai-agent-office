-- AGO-102 QA: acceptance-criteria tests written independently of run_events_append_only.test.sql.
-- Run: pnpm exec supabase test db (inside the db lock). Everything rolls back.
--   AC1  update / delete / truncate / upsert / merge on run_events are rejected for anon, authenticated,
--        service_role and the owner; app roles cannot disable the guard; run and agent deletes keep events
--   AC2  per-run seq: omitted -> next, duplicate / lower / gap / negative rejected (23514), runs independent,
--        cross-workspace insert rejected
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

insert into public.workspaces (id, name) values
  ('a1020000-0000-0000-0000-000000000001', 'qa one'), ('a1020000-0000-0000-0000-000000000002', 'qa two');
insert into public.agents (id, workspace_id, name) values
  ('a1020000-0000-0000-0000-0000000000a1', 'a1020000-0000-0000-0000-000000000001', 'qa agent');
insert into public.runs (id, workspace_id, agent_id) values
  ('a1020000-0000-0000-0000-0000000000b1', 'a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000a1'),
  ('a1020000-0000-0000-0000-0000000000b2', 'a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000a1'),
  ('a1020000-0000-0000-0000-0000000000b3', 'a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000a1');
insert into public.run_events (workspace_id, run_id, type) values
  ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 'one'),
  ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 'two'),
  ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b2', 'one');

-- AC1: any role, any write path other than insert
select throws_ok($$set local role service_role; update public.run_events set type = 'x' where type = 'one'$$, '42501', null, 'AC1: service_role UPDATE with a WHERE is rejected');
select throws_ok($$set local role service_role; delete from public.run_events where type = 'one'$$, '42501', null, 'AC1: service_role DELETE with a WHERE is rejected');
select throws_ok($$set local role service_role; insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 1, 'x') on conflict (workspace_id, run_id, seq) do update set type = 'x'$$, '42501', null, 'AC1: service_role upsert (ON CONFLICT DO UPDATE) is rejected');
select throws_ok($$set local role anon; update public.run_events set type = 'x' where type = 'one'$$, '42501', null, 'AC1: anon UPDATE is rejected');
select throws_ok($$set local role authenticated; delete from public.run_events where type = 'one'$$, '42501', null, 'AC1: authenticated DELETE is rejected');
select throws_ok($$merge into public.run_events t using (select id from public.run_events limit 1) s on t.id = s.id when matched then delete$$, '42501', 'run_events is append-only: DELETE is not allowed', 'AC1: owner MERGE ... DELETE is rejected');
select throws_ok($$merge into public.run_events t using (select id from public.run_events limit 1) s on t.id = s.id when matched then update set type = 'x'$$, '42501', 'run_events is append-only: UPDATE is not allowed', 'AC1: owner MERGE ... UPDATE is rejected');
select throws_ok($$truncate public.run_events cascade$$, '42501', null, 'AC1: owner TRUNCATE ... CASCADE is rejected');

-- AC1: the guard cannot be switched off by an application role
select throws_ok($$set local role service_role; alter table public.run_events disable trigger run_events_block_update_delete$$, '42501', 'must be owner of table run_events', 'AC1: service_role cannot disable the guard trigger');
select throws_ok($$set local role authenticated; alter table public.run_events disable trigger all$$, '42501', 'must be owner of table run_events', 'AC1: authenticated cannot disable all triggers');
select throws_ok($$set local role anon; drop trigger run_events_block_truncate on public.run_events$$, '42501', 'must be owner of relation run_events', 'AC1: anon cannot drop the truncate guard');
select throws_ok($$set local role service_role; set session_replication_role = replica$$, '42501', null, 'AC1: service_role cannot switch to replica mode (which skips normal triggers)');
select lives_ok($$set local role service_role; grant update, delete, truncate on public.run_events to service_role; reset role$$, 'AC1: service_role trying to grant itself UPDATE/DELETE/TRUNCATE is a no-op (it does not hold them)');
select is((select bool_or(has_table_privilege('service_role', 'public.run_events', p)) from unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) p), false, 'AC1: service_role still holds no UPDATE/DELETE/TRUNCATE after that attempt');

-- AC1: deleting the parents of events keeps the events (history is retained)
select throws_ok($$set local role service_role; delete from public.runs where id = 'a1020000-0000-0000-0000-0000000000b1'$$, '23503', null, 'AC1: service_role cannot delete a run that has events');
select throws_ok($$delete from public.agents where id = 'a1020000-0000-0000-0000-0000000000a1'$$, '23503', null, 'AC1: the owner cannot delete an agent whose runs have events');
select is((select count(*)::int from public.run_events where workspace_id = 'a1020000-0000-0000-0000-000000000001'), 3, 'AC1: all three events are still there after every rejected attempt');
select is((select string_agg(type, ',' order by run_id, seq) from public.run_events where workspace_id = 'a1020000-0000-0000-0000-000000000001'), 'one,two,one', 'AC1: no event content changed');

-- AC1 (fix round 1): the workspace cascade used to erase events; now deleting a workspace with events is refused
select throws_ok($$set local role service_role; delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000001'$$, '23503', null, 'AC1: service_role cannot delete a workspace that has events');
select throws_ok($$delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000001'$$, '23503', null, 'AC1: the owner cannot delete a workspace that has events');
select throws_ok($$set local role authenticated; delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000001'$$, '42501', null, 'AC1: authenticated cannot delete a workspace');
select throws_ok($$set local role anon; delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000001'$$, '42501', null, 'AC1: anon cannot delete a workspace');
select throws_ok($$delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000001' or name like 'qa%'$$, '23503', null, 'AC1: a multi-row workspace delete that includes the one with events is refused as a whole');
select is((select count(*)::int from public.run_events where workspace_id = 'a1020000-0000-0000-0000-000000000001'), 3, 'AC1: the events survive every workspace delete attempt');
select lives_ok($$set local role service_role; delete from public.runs where id = 'a1020000-0000-0000-0000-0000000000b3'$$, 'AC1: a run without events can still be deleted');
select lives_ok($$set local role service_role; delete from public.workspaces where id = 'a1020000-0000-0000-0000-000000000002'$$, 'AC1: a workspace without events can still be deleted');
select is((select array_agg(confdeltype::text order by conname) from pg_constraint where conrelid = 'public.run_events'::regclass and contype = 'f' and confrelid in ('public.workspaces'::regclass, 'public.runs'::regclass)), array['r', 'r'], 'AC1: both run_events parent FKs (workspace, run) are ON DELETE RESTRICT');

-- AC1 (fix round 1): no bypass shipped in the database; the teardown lives only in scripts/
select is((select count(*)::int from pg_trigger where tgrelid = 'public.run_events'::regclass and not tgisinternal and tgenabled <> 'A'), 0, 'AC1: every run_events guard trigger is ENABLE ALWAYS');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and p.prosrc ~* '(disable\s+trigger|session_replication_role|delete\s+from\s+public\.run_events|truncate)'), 0, 'AC1: no project function (public, private) can disable the guard or delete events');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and p.proname ilike '%teardown%'), 0, 'AC1: no teardown/cleanup routine exists as a database object');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.prosecdef and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))), 0, 'AC1: no SECURITY DEFINER function in private is executable by anon, authenticated or service_role');

-- AC2: per-run seq
select is((select string_agg(seq::text, ',' order by seq) from public.run_events where run_id = 'a1020000-0000-0000-0000-0000000000b1'), '1,2', 'AC2: omitted seq is assigned 1, 2 in insert order');
select is((select seq from public.run_events where run_id = 'a1020000-0000-0000-0000-0000000000b2'), 1::bigint, 'AC2: another run starts again at 1 (per run, not global)');
select throws_ok($$insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 2, 'dup')$$, '23514', null, 'AC2: a duplicate seq is rejected');
select throws_ok($$insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 1, 'low')$$, '23514', null, 'AC2: a lower (out-of-order) seq is rejected');
select throws_ok($$insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 4, 'gap')$$, '23514', null, 'AC2: a gapped seq (max + 2) is rejected, matching the documented max + 1 rule');
select throws_ok($$insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', -5, 'neg')$$, '23514', null, 'AC2: a negative seq is rejected');
select lives_ok($$insert into public.run_events (workspace_id, run_id, seq, type) values ('a1020000-0000-0000-0000-000000000001', 'a1020000-0000-0000-0000-0000000000b1', 3, 'next')$$, 'AC2: seq = max + 1 is accepted');
select throws_ok($$insert into public.run_events (workspace_id, run_id, type) values ('a1020000-0000-0000-0000-000000000002', 'a1020000-0000-0000-0000-0000000000b1', 'x')$$, '23503', null, 'AC2: an event for a run under another workspace is rejected, so a run cannot get a second seq 1');
select is((select string_agg(seq::text, ',' order by seq) from public.run_events where run_id = 'a1020000-0000-0000-0000-0000000000b1'), '1,2,3', 'AC2: the run ends gap-free 1,2,3 after every rejected insert');
select is((select count(*)::int from pg_constraint where conrelid = 'public.run_events'::regclass and conname in ('run_events_seq_positive', 'run_events_run_seq_key')), 2, 'AC2: seq > 0 and unique (workspace_id, run_id, seq) back the trigger as constraints');

select * from finish();
rollback;
