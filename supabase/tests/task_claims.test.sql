-- AGO-160: task claims with expiry (pgTAP).
--   privileges: the four claim functions are SECURITY DEFINER, search_path = '', executable by service_role only;
--   claim_task: one winner, held (no token), refusals with a specific reason (ttl, task, agent, workspace, archived,
--   run); expiry by the database clock and takeover; fence: a stale token cannot renew, release or complete, also
--   after another agent took over an expired claim; sweep; the unique index backstop;
--   claim_events: written for every change, never holds the token, append-only (update, delete, truncate refused),
--   members can read it; claim_token is not readable by members.
-- The concurrent two-connection race is a live-DB Vitest test (apps/worker/src/claims/claims.integration.test.ts).
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into public.workspaces (id, name) values
  ('16000000-0000-4000-8000-0000000000a1', 'AGO-160 A'),
  ('16000000-0000-4000-8000-0000000000b1', 'AGO-160 B');
insert into public.agents (id, workspace_id, name, archived_at) values
  ('16000000-0000-4000-8000-0000000002a1', '16000000-0000-4000-8000-0000000000a1', 'agent-1', null),
  ('16000000-0000-4000-8000-0000000002a2', '16000000-0000-4000-8000-0000000000a1', 'agent-2', null),
  ('16000000-0000-4000-8000-0000000002a3', '16000000-0000-4000-8000-0000000000a1', 'agent-archived', now()),
  ('16000000-0000-4000-8000-0000000002b1', '16000000-0000-4000-8000-0000000000b1', 'agent-b', null);
insert into public.tasks (id, workspace_id, title) values
  ('16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000000a1', 'task a1'),
  ('16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000000a1', 'task a2'),
  ('16000000-0000-4000-8000-0000000006b1', '16000000-0000-4000-8000-0000000000b1', 'task b1');
insert into public.runs (id, workspace_id, agent_id) values
  ('16000000-0000-4000-8000-0000000007a1', '16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000002a1');

create temp table ctx (k text primary key, claim_id uuid, token uuid);

-- 1. Functions exist; exactly service_role may execute them; SECURITY DEFINER with an empty search_path.
select has_function('public', 'claim_task', array['uuid', 'uuid', 'uuid', 'uuid', 'integer'], 'claim_task exists');
select has_function('public', 'renew_claim', array['uuid', 'uuid', 'uuid', 'integer'], 'renew_claim exists');
select has_function('public', 'release_claim', array['uuid', 'uuid', 'uuid', 'text'], 'release_claim exists');
select has_function('public', 'sweep_expired_claims', array['uuid'], 'sweep_expired_claims exists');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('claim_task', 'renew_claim', 'release_claim', 'sweep_expired_claims')
      and p.prosecdef
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)),
  4, 'the four claim functions are SECURITY DEFINER and executable by service_role only (not PUBLIC, anon, authenticated)');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and p.proname in ('claim_task', 'renew_claim', 'release_claim', 'sweep_expired_claims', 'log_claim_event', 'claim_events_block_change')
      and p.prosecdef
      and exists (select 1 from unnest(p.proconfig) cfg where cfg in ('search_path=""', 'search_path=''''', 'search_path=')) ),
  6, 'every SECURITY DEFINER function of this ticket sets search_path to empty');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'private'::regnamespace and p.proname = 'log_claim_event'
      and (has_function_privilege('service_role', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute'))),
  0, 'the private event writer is not callable by any API role');

-- 2. Claim columns and privileges: members read claims but not the fence token.
select is(has_column_privilege('authenticated', 'public.claims', 'claim_token', 'select'), false, 'members cannot read claim_token');
select is(has_column_privilege('authenticated', 'public.claims', 'expires_at', 'select'), true, 'members can read expires_at');
select is(has_column_privilege('anon', 'public.claims', 'claim_token', 'select'), false, 'anon cannot read claim_token');

-- 3. claim_task: the first claim wins and gets a token; the second is told who holds it, without the token.
insert into ctx select 'c1', r.claim_id, r.claim_token
  from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a1', '16000000-0000-4000-8000-0000000007a1', 120) r
  where r.outcome = 'claimed';
select is((select count(*)::int from ctx where k = 'c1'), 1, 'agent 1 claims task a1');
select isnt((select token from ctx where k = 'c1'), null, 'the winner has a claim token');
select ok((select expires_at > now() and expires_at <= now() + interval '120 seconds' from public.claims where id = (select claim_id from ctx where k = 'c1')),
  'expiry is now() plus the ttl (database clock)');

select results_eq(
  $$select outcome, reason, claim_token is null, holder_agent_id from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a2', null, 120)$$,
  $$values ('held'::text, 'task_already_claimed'::text, true, '16000000-0000-4000-8000-0000000002a1'::uuid)$$,
  'agent 2 is told the task is held by agent 1 and gets no token');
select is((select outcome from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a1', null, 120)),
  'held', 'the holder claiming again is also told held (no second claim, no new token)');
select is((select count(*)::int from public.claims where task_id = '16000000-0000-4000-8000-0000000006a1' and released_at is null), 1,
  'exactly one active claim on the task');
select throws_ok(
  $$insert into public.claims (workspace_id, task_id, agent_id) values ('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a2')$$,
  '23505', null, 'the partial unique index refuses a second active claim even by direct insert');

-- 4. Refusals carry a specific reason.
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002a1', null, 5)), 'invalid_ttl', 'ttl below 10 s refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002a1', null, 3601)), 'invalid_ttl', 'ttl above 1 h refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-00000000ffff', '16000000-0000-4000-8000-0000000002a1')), 'task_not_found', 'unknown task refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-00000000ffff')), 'agent_not_found', 'unknown agent refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006b1', '16000000-0000-4000-8000-0000000002a1')), 'workspace_mismatch', 'a task of another workspace is refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002b1')), 'workspace_mismatch', 'an agent of another workspace is refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000b1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002b1')), 'workspace_mismatch', 'claiming with the wrong workspace id is refused');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002a3')), 'agent_archived', 'an archived agent cannot claim (AGO-89 follow-up 2)');
select is((select reason from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002a2', '16000000-0000-4000-8000-0000000007a1')), 'run_mismatch', 'a run of another agent is refused');
select is((select count(*)::int from public.claims where task_id = '16000000-0000-4000-8000-0000000006a2'), 0, 'no refusal left a claim behind');

-- 5. Renew: the current token extends; a wrong token is refused.
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), gen_random_uuid(), 120)), 'stale_token', 'renew with a wrong token is refused');
select is((select outcome from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 600)), 'renewed', 'renew with the current token works');
select ok((select expires_at > now() + interval '500 seconds' and renewed_at is not null from public.claims where id = (select claim_id from ctx where k = 'c1')), 'renew moved the expiry and set renewed_at');
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 5)), 'invalid_ttl', 'renew with a bad ttl is refused');
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', gen_random_uuid(), gen_random_uuid(), 120)), 'claim_not_found', 'renew of an unknown claim is refused');
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000b1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 120)), 'claim_not_found', 'renew with another workspace id finds nothing');

-- 6. Expiry by the database clock: an expired claim cannot be renewed, and another agent takes it.
update public.claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
  where id = (select claim_id from ctx where k = 'c1');
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 120)), 'claim_expired', 'an expired claim cannot be renewed, even with the right token');
insert into ctx select 'c2', r.claim_id, r.claim_token
  from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a2', null, 120) r
  where r.outcome = 'claimed';
select is((select count(*)::int from ctx where k = 'c2'), 1, 'agent 2 takes the expired claim');
select isnt((select token from ctx where k = 'c2'), (select token from ctx where k = 'c1'), 'the takeover has a new token');
select is((select release_reason from public.claims where id = (select claim_id from ctx where k = 'c1')), 'expired_takeover', 'the old claim is marked expired_takeover');
select is((select agent_id from public.claims where id = (select claim_id from ctx where k = 'c2')), '16000000-0000-4000-8000-0000000002a2'::uuid, 'the new claim belongs to agent 2');

-- 7. Fence: after the takeover the old holder cannot renew, release or complete (old id and token, or old token on the new claim).
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 120)), 'claim_expired', 'old holder: renew of the old claim refused');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 'released')), 'claim_expired', 'old holder: release of the old claim refused');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c1'), (select token from ctx where k = 'c1'), 'completed')), 'claim_expired', 'old holder: complete of the old claim refused');
select is((select reason from public.renew_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c1'), 120)), 'stale_token', 'old token on the new claim: renew refused');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c1'), 'released')), 'stale_token', 'old token on the new claim: release refused');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c1'), 'completed')), 'stale_token', 'old token on the new claim: complete refused');
select is((select count(*)::int from public.claims where id = (select claim_id from ctx where k = 'c2') and released_at is null), 1, 'the new claim is still active after every stale attempt');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c2'), 'nonsense')), 'invalid_reason', 'an unknown release reason is refused');

-- 8. The new holder completes; the task is free again.
select is((select outcome from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c2'), 'completed')), 'completed', 'the current holder completes the claim');
select is((select reason from public.release_claim('16000000-0000-4000-8000-0000000000a1', (select claim_id from ctx where k = 'c2'), (select token from ctx where k = 'c2'), 'completed')), 'claim_released', 'a completed claim cannot be completed twice');
select is((select outcome from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a1', '16000000-0000-4000-8000-0000000002a1', null, 120)), 'claimed', 'after completion the task can be claimed again');

-- 9. Sweep: frees expired claims (one workspace or all), logs each, and leaves live claims alone.
select is((select outcome from public.claim_task('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000002a1', null, 120)), 'claimed', 'agent 1 claims task a2');
select is((select outcome from public.claim_task('16000000-0000-4000-8000-0000000000b1', '16000000-0000-4000-8000-0000000006b1', '16000000-0000-4000-8000-0000000002b1', null, 120)), 'claimed', 'agent b claims task b1 (workspace B)');
update public.claims set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
  where task_id in ('16000000-0000-4000-8000-0000000006a2', '16000000-0000-4000-8000-0000000006b1') and released_at is null;
select is(public.sweep_expired_claims('16000000-0000-4000-8000-0000000000a1'), 1, 'sweeping workspace A frees its one expired claim');
select is((select release_reason from public.claims where task_id = '16000000-0000-4000-8000-0000000006a2'), 'expired_sweep', 'the swept claim is marked expired_sweep');
select is((select count(*)::int from public.claims where task_id = '16000000-0000-4000-8000-0000000006b1' and released_at is null), 1, 'workspace B was not touched by the sweep of A');
select is(public.sweep_expired_claims(), 1, 'sweeping everything frees workspace B''s claim');
select is(public.sweep_expired_claims(), 0, 'a second sweep finds nothing');
select is((select count(*)::int from public.claims where task_id = '16000000-0000-4000-8000-0000000006a1' and released_at is null), 1, 'the live claim on task a1 survived the sweeps');

-- 10. Events: one row for each change, no token inside, append-only, readable by members.
select is((select count(*)::int from public.claim_events where claim_id = (select claim_id from ctx where k = 'c1') and type = 'claim.acquired'), 1, 'acquired event for the first claim');
select is((select count(*)::int from public.claim_events where claim_id = (select claim_id from ctx where k = 'c1') and type = 'claim.renewed'), 1, 'renewed event for the first claim');
select is((select count(*)::int from public.claim_events where claim_id = (select claim_id from ctx where k = 'c1') and type = 'claim.expired' and payload ->> 'cause' = 'takeover'), 1, 'expired (takeover) event for the first claim');
select is((select count(*)::int from public.claim_events where claim_id = (select claim_id from ctx where k = 'c2') and type = 'claim.completed'), 1, 'completed event for the second claim');
select is((select count(*)::int from public.claim_events where type = 'claim.expired' and payload ->> 'cause' = 'sweep'), 2, 'one expired (sweep) event per swept claim');
select is((select count(*)::int from public.claim_events e, ctx c where e.payload::text like '%' || c.token::text || '%'), 0, 'no event payload holds a claim token');
select throws_ok($$update public.claim_events set type = 'claim.released'$$, '42501', null, 'claim_events: update refused for the table owner');
select throws_ok($$delete from public.claim_events$$, '42501', null, 'claim_events: delete refused for the table owner');
select throws_ok($$truncate public.claim_events$$, '42501', null, 'claim_events: truncate refused for the table owner');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'claim_events'
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no API role holds insert, update, delete or truncate on claim_events');
select is(has_table_privilege('authenticated', 'public.claim_events', 'select'), true, 'members hold select on claim_events');
select is((select relrowsecurity from pg_class where oid = 'public.claim_events'::regclass), true, 'claim_events has RLS on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'claim_events' and cmd = 'SELECT'), 1, 'claim_events has a member read policy');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'claim_events' and cmd <> 'SELECT'), 0, 'claim_events has no write policy');

-- 11. Deleting the whole workspace is the one allowed removal (tenant erasure).
select lives_ok($$delete from public.workspaces where id = '16000000-0000-4000-8000-0000000000b1'$$, 'deleting a workspace removes its claims and events');
select is((select count(*)::int from public.claim_events where workspace_id = '16000000-0000-4000-8000-0000000000b1'), 0, 'no event of the deleted workspace remains');

select * from finish();
rollback;
