-- AGO-102: run_events is append-only for every role, and seq increases per run.
-- Run: pnpm exec supabase test db (inside the db lock). Concurrency is covered by
-- scripts/run-events-concurrency.test.mjs (needs several connections).
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

-- Fixtures (as postgres): one workspace, one agent, two runs, two workspaces (A has events, B has none) for the delete checks.
insert into public.workspaces (id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'AGO-102 A'),
  ('dddddddd-0000-0000-0000-000000000001', 'AGO-102 B');
insert into public.agents (id, workspace_id, name) values
  ('cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'agent-a'),
  ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 'agent-b');
insert into public.runs (id, workspace_id, agent_id) values
  ('cccccccc-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003'),
  ('cccccccc-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003'),
  ('dddddddd-0000-0000-0000-000000000006', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000003');

-- 1-3. privileges and triggers (catalog)
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r,
      unnest(array['UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) p
    where has_table_privilege(r, 'public.run_events'::regclass, p))
  + (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r
      where has_any_column_privilege(r, 'public.run_events'::regclass, 'UPDATE')),
  0, 'anon, authenticated and service_role hold no UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES (table or column level)');
select is(
  (select count(*)::int from pg_class c, aclexplode(c.relacl) a
    where c.oid = 'public.run_events'::regclass and a.grantee = 0
      and a.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'PUBLIC holds no UPDATE/DELETE/TRUNCATE on run_events');
select is(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.run_events'::regclass and not tgisinternal
      and tgname in ('run_events_before_insert', 'run_events_block_update_delete', 'run_events_block_truncate')
      and tgenabled = 'A'),
  3, 'the 3 run_events triggers exist and are ENABLE ALWAYS (they fire even in replica mode)');

-- 4-12. per-run sequence (inserts as service_role)
set local role service_role;
insert into public.run_events (workspace_id, run_id, type) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'run.started'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step');
insert into public.run_events (workspace_id, run_id, type, payload) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', '{"k": 1}');
insert into public.run_events (workspace_id, run_id, type) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000007', 'run.started');
reset role;
select is(
  (select array_agg(seq order by seq) from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  array[1, 2, 3]::bigint[], 'omitted seq is assigned 1, 2, 3 within a run');
select is(
  (select seq from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000007'),
  1::bigint, 'another run starts again at 1 (per-run, not global)');

set local role service_role;
insert into public.run_events (workspace_id, run_id, type, seq) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', 4);
reset role;
select is(
  (select max(seq) from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  4::bigint, 'an explicit seq equal to max + 1 is accepted');
set local role service_role;
insert into public.run_events (workspace_id, run_id, type, seq) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', null);
reset role;
select is(
  (select max(seq) from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  5::bigint, 'a null seq is assigned max + 1');

select throws_ok(
  $$set local role service_role;
    insert into public.run_events (workspace_id, run_id, type, seq)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', 5)$$,
  '23514', null, 'a duplicate seq (equal to the last) is rejected');
select throws_ok(
  $$set local role service_role;
    insert into public.run_events (workspace_id, run_id, type, seq)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', 2)$$,
  '23514', null, 'an out-of-order (lower) seq is rejected');
select throws_ok(
  $$set local role service_role;
    insert into public.run_events (workspace_id, run_id, type, seq)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', 9223372036854775807)$$,
  '23514', null, 'a huge seq (gap, would overflow the next insert) is rejected');
select throws_ok(
  $$set local role service_role;
    insert into public.run_events (workspace_id, run_id, type, seq)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000006', 'step', -1)$$,
  '23514', null, 'a negative seq is rejected');
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.run_events'::regclass and conname = 'run_events_run_seq_key' and contype = 'u'),
  1, 'unique (workspace_id, run_id, seq) backs the trigger');
select is(
  (select count(*)::int from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  5, 'rejected inserts left no rows behind');

-- 13-24. every role is rejected when changing or removing rows (privilege check or trigger, 42501)
select throws_ok($$set local role anon; update public.run_events set type = 'x'$$, '42501', null, 'anon cannot UPDATE');
select throws_ok($$set local role anon; delete from public.run_events$$, '42501', null, 'anon cannot DELETE');
select throws_ok($$set local role anon; truncate public.run_events$$, '42501', null, 'anon cannot TRUNCATE');
select throws_ok($$set local role authenticated; update public.run_events set type = 'x'$$, '42501', null, 'authenticated cannot UPDATE');
select throws_ok($$set local role authenticated; delete from public.run_events$$, '42501', null, 'authenticated cannot DELETE');
select throws_ok($$set local role authenticated; truncate public.run_events$$, '42501', null, 'authenticated cannot TRUNCATE');
select throws_ok($$set local role service_role; update public.run_events set type = 'x'$$, '42501', null, 'service_role cannot UPDATE');
select throws_ok($$set local role service_role; delete from public.run_events$$, '42501', null, 'service_role cannot DELETE');
select throws_ok($$set local role service_role; truncate public.run_events$$, '42501', null, 'service_role cannot TRUNCATE');
select throws_ok($$update public.run_events set type = 'x'$$, '42501', 'run_events is append-only: UPDATE is not allowed', 'postgres (owner) cannot UPDATE');
select throws_ok($$delete from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'$$, '42501', 'run_events is append-only: DELETE is not allowed', 'postgres (owner) cannot DELETE');
select throws_ok($$truncate public.run_events$$, '42501', 'run_events is append-only: TRUNCATE is not allowed', 'postgres (owner) cannot TRUNCATE');

-- 25-28. defence in depth: even if the privileges were granted back, the triggers still block service_role,
-- and they still fire in replica mode (the usual way to switch triggers off for a bulk load).
grant update, delete, truncate on public.run_events to service_role;
select throws_like($$set local role service_role; update public.run_events set type = 'x'$$, '%append-only%', 'with UPDATE granted back, the trigger still blocks service_role');
select throws_like($$set local role service_role; delete from public.run_events$$, '%append-only%', 'with DELETE granted back, the trigger still blocks service_role');
select throws_like($$set local role service_role; truncate public.run_events$$, '%append-only%', 'with TRUNCATE granted back, the trigger still blocks service_role');
set local session_replication_role = replica;
select throws_like($$update public.run_events set type = 'x'$$, '%append-only%', 'the triggers also fire when session_replication_role = replica');
set local session_replication_role = origin;

-- 29. nothing changed
select is(
  (select jsonb_agg(jsonb_build_object('seq', seq, 'type', type, 'payload', payload) order by seq)
     from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  '[{"seq":1,"type":"run.started","payload":{}},{"seq":2,"type":"step","payload":{}},
    {"seq":3,"type":"step","payload":{"k":1}},{"seq":4,"type":"step","payload":{}},
    {"seq":5,"type":"step","payload":{}}]'::jsonb,
  'after all attempts the events are exactly as inserted');

-- 30. no delete path at all: a workspace or run that has events cannot be deleted (ON DELETE RESTRICT),
-- not even by service_role or the owner. Erasure of events is a deliberate human-only path (AGO-147).
grant delete on public.workspaces, public.runs to service_role; -- rolled back with the test; proves RESTRICT, not privileges
select throws_ok($$delete from public.workspaces where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '23503', null, 'postgres (owner) cannot delete a workspace that has events');
select throws_ok($$set local role service_role; delete from public.workspaces where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '23503', null, 'service_role cannot delete a workspace that has events');
select throws_ok($$set local role anon; delete from public.workspaces where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '42501', null, 'anon cannot delete a workspace');
select throws_ok($$set local role authenticated; delete from public.workspaces where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '42501', null, 'authenticated cannot delete a workspace');
select throws_ok($$delete from public.runs where id = 'cccccccc-0000-0000-0000-000000000006'$$,
  '23503', null, 'postgres (owner) cannot delete a run that has events');
select throws_ok($$set local role service_role; delete from public.runs where id = 'cccccccc-0000-0000-0000-000000000006'$$,
  '23503', null, 'service_role cannot delete a run that has events');
select is(
  (select count(*)::int from public.run_events where run_id = 'cccccccc-0000-0000-0000-000000000006'),
  5, 'the refused deletes left the events untouched');
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.run_events'::regclass and contype = 'f' and confdeltype = 'r'),
  2, 'both run_events foreign keys (workspace, run) are ON DELETE RESTRICT');
select is(
  (select count(*)::int from pg_proc
    where oid = 'private.run_events_block_change()'::regprocedure and prosrc like '%workspaces%'),
  0, 'the block trigger has no "workspace gone" exception any more');

-- deleting a run or workspace that has no events still works
insert into public.runs (id, workspace_id, agent_id) values
  ('cccccccc-0000-0000-0000-000000000008', 'cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003');
select lives_ok($$delete from public.runs where id = 'cccccccc-0000-0000-0000-000000000008'$$,
  'a run without events can still be deleted');
select lives_ok($$set local role service_role; delete from public.workspaces where id = 'dddddddd-0000-0000-0000-000000000001'$$,
  'a workspace without events can still be deleted (its other data cascades)');
reset role;
select is(
  (select count(*)::int from public.runs where workspace_id = 'dddddddd-0000-0000-0000-000000000001'),
  0, 'the events-free workspace took its runs with it');

select * from finish();
rollback;
