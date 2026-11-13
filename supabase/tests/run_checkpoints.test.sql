-- AGO-30: private.run_checkpoints (durable run state and the pause request).
--   no API role can read or write it; a checkpoint cannot name another workspace's run; the state must be an object
--   under 1 MB; one row per run; deleting the run deletes its checkpoint; updated_at moves on update.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into public.workspaces (id, name) values
  ('30000000-0000-4000-8000-0000000000a1', 'AGO-30 A'),
  ('30000000-0000-4000-8000-0000000000b1', 'AGO-30 B');
insert into public.agents (id, workspace_id, name) values
  ('30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-0000000000a1', 'agent-a'),
  ('30000000-0000-4000-8000-0000000002b1', '30000000-0000-4000-8000-0000000000b1', 'agent-b');
insert into public.runs (id, workspace_id, agent_id) values
  ('30000000-0000-4000-8000-0000000007a1', '30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000002a1'),
  ('30000000-0000-4000-8000-0000000007a2', '30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000002a1'),
  ('30000000-0000-4000-8000-0000000007b1', '30000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000002b1');

-- 1-2. the table exists in private, RLS on
select has_table('private', 'run_checkpoints', 'private.run_checkpoints exists');
select is((select relrowsecurity from pg_class where oid = 'private.run_checkpoints'::regclass), true, 'RLS is on');

-- 3-4. nothing in public: tool results never ride the Data API
select hasnt_table('public', 'run_checkpoints', 'no public.run_checkpoints');
select is(
  (select count(*)::int from pg_class where relnamespace = 'private'::regnamespace and relname = 'run_checkpoints'
      and (has_table_privilege('anon', oid, 'select,insert,update,delete')
        or has_table_privilege('authenticated', oid, 'select,insert,update,delete')
        or has_table_privilege('service_role', oid, 'select,insert,update,delete'))),
  0, 'anon, authenticated and service_role have no privilege on it');

-- 5-8. the owner role writes: a row with state and a pause request, one row per run
select lives_ok($$insert into private.run_checkpoints (workspace_id, run_id, state)
  values ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000007a1', '{"version":1}')$$, 'a checkpoint row is written');
select throws_ok($$insert into private.run_checkpoints (workspace_id, run_id)
  values ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000007a1')$$, '23505', null, 'one row per run');
select lives_ok($$insert into private.run_checkpoints (workspace_id, run_id, pause_requested_at)
  values ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000007a2', now())$$, 'a pause can be requested before any state exists (null state)');
select is((select state from private.run_checkpoints where run_id = '30000000-0000-4000-8000-0000000007a2'), null, 'that row has a null state');

-- 9. a checkpoint cannot name another workspace's run
select throws_ok($$insert into private.run_checkpoints (workspace_id, run_id)
  values ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000007b1')$$, '23503', null, 'a run of workspace B cannot be checkpointed under workspace A');

-- 10-12. the state must be an object under 1 MB
select throws_ok($$update private.run_checkpoints set state = '[1]'
  where run_id = '30000000-0000-4000-8000-0000000007a1'$$, '23514', null, 'a non-object state is rejected');
select throws_ok($$update private.run_checkpoints set state = jsonb_build_object('blob', repeat('x', 1000001))
  where run_id = '30000000-0000-4000-8000-0000000007a1'$$, '23514', null, 'a state over 1 MB is rejected');
select lives_ok($$update private.run_checkpoints set state = jsonb_build_object('blob', repeat('x', 900000))
  where run_id = '30000000-0000-4000-8000-0000000007a1'$$, 'a state under 1 MB is accepted');

-- 13. updated_at moves on update, created_at does not
update private.run_checkpoints set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'
 where run_id = '30000000-0000-4000-8000-0000000007a1';
update private.run_checkpoints set state = '{"version":1}' where run_id = '30000000-0000-4000-8000-0000000007a1';
select ok((select updated_at > created_at + interval '30 minutes' from private.run_checkpoints
            where run_id = '30000000-0000-4000-8000-0000000007a1'), 'updated_at is stamped on update');

-- 14-15. an authenticated user cannot touch it, even as a workspace member
insert into auth.users (id, instance_id, aud, role, email) values
  ('30000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago30-o@example.test');
insert into public.members (id, workspace_id, user_id, role) values
  ('30000000-0000-4000-8000-0000000001a1', '30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-00000000000a', 'owner');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"30000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select 1 from private.run_checkpoints$$, '42501', null, 'an owner of the workspace cannot read checkpoints');
select throws_ok($$update private.run_checkpoints set state = '{}'$$, '42501', null, 'an owner of the workspace cannot write checkpoints');
reset role;

-- 16. deleting the run deletes its checkpoint
delete from public.runs where id = '30000000-0000-4000-8000-0000000007a2';
select is((select count(*)::int from private.run_checkpoints where run_id = '30000000-0000-4000-8000-0000000007a2'), 0, 'the checkpoint goes with its run');

select * from finish();
rollback;
