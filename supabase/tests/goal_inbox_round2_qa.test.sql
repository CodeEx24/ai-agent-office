-- AGO-113 round 2 (pgTAP): submit_goal is human-only. Tokens with an agent_id, run_id or agent_credential claim, or a
-- role other than authenticated, are refused with 42501 before anything is written; a plain member session still works.
-- Run: pnpm exec supabase test db (inside the db lock as AGO-113).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email) values
  ('11320000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113r2-member@example.test'),
  ('11320000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago113r2-viewer@example.test');
insert into public.workspaces (id, name) values ('11321111-0000-0000-0000-000000000001', 'AGO-113 R2 W');
insert into public.members (id, workspace_id, user_id, role) values
  ('11321111-0000-0000-0000-0000000000a1', '11321111-0000-0000-0000-000000000001', '11320000-0000-0000-0000-0000000000a1', 'member'),
  ('11321111-0000-0000-0000-0000000000a2', '11321111-0000-0000-0000-000000000001', '11320000-0000-0000-0000-0000000000a2', 'viewer');
insert into public.agents (id, workspace_id, name, role) values
  ('11321111-0000-0000-0000-000000000b01', '11321111-0000-0000-0000-000000000001', 'manager', 'Manager');

-- Helper outside the authenticated role: sets the JWT claims, returns the text to run.
create function pg_temp.claims(p text) returns text language sql as
  $$ select set_config('request.jwt.claims', p, true) $$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;

-- 1. Baseline: a plain member session works (so the refusals below are caused by the claims, nothing else).
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1","role":"authenticated"}');
select lives_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'baseline goal') $$,
  'a plain member session submits a goal');

-- 2. Claim present with a member sub, every claim name, every value shape: refused. The check is on the claim being
-- present at all, so null, empty string, false, 0, empty object and array values all count.
select throws_ok(
  format('select pg_temp.claims(%L) is not null and public.submit_goal(%L, %L) is not null',
    format('{"sub":"11320000-0000-0000-0000-0000000000a1","role":"authenticated","%s":%s}', c, v),
    '11321111-0000-0000-0000-000000000001', 'claim ' || c || ' = ' || v),
  '42501', 'a human session is required to submit a goal',
  format('a member token with %s = %s is refused', c, v))
from (values ('agent_id'), ('run_id'), ('agent_credential')) as claim(c)
cross join (values ('null'), ('""'), ('"x"'), ('"11320000-0000-0000-0000-0000000000a9"'), ('false'), ('0'), ('123'), ('{}'), ('[]'), ('{"a":1}')) as val(v);

-- 3. All three together; a nested agent_id inside app_metadata is not a top-level claim (documents the rule).
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1","role":"authenticated","agent_id":"a","run_id":"b","agent_credential":"c"}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'all claims') $$,
  '42501', 'a human session is required to submit a goal', 'all three agent claims together are refused');
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1","role":"authenticated","email":"x@example.test","app_metadata":{"agent_id":"nested"}}');
select lives_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'unrelated claims ok') $$,
  'a nested agent_id inside app_metadata is not a top-level claim and is not refused');

-- 4. Agent claim for a viewer: refused. A plain viewer is still refused by the membership check.
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a2","role":"authenticated","agent_id":"x"}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'viewer agent') $$,
  '42501', 'a human session is required to submit a goal', 'a viewer token with an agent claim is refused by the human-only check');
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a2","role":"authenticated"}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'viewer plain') $$,
  '42501', 'only workspace members can submit goals', 'a plain viewer is still refused by the membership check');

-- 5. Role claim other than authenticated, or missing, or not a string.
select throws_ok(
  format('select pg_temp.claims(%L) is not null and public.submit_goal(%L, %L) is not null',
    format('{"sub":"11320000-0000-0000-0000-0000000000a1","role":%s}', to_json(r)::text),
    '11321111-0000-0000-0000-000000000001', 'role ' || r),
  '42501', 'a human session is required to submit a goal', format('a member token with role "%s" is refused', r))
from unnest(array['service_role', 'anon', 'supabase_admin', 'postgres', '', 'Authenticated', 'AUTHENTICATED', ' authenticated']) as r;
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1"}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'no role') $$,
  '42501', 'a human session is required to submit a goal', 'a token with no role claim is refused');
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1","role":null}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'null role') $$,
  '42501', 'a human session is required to submit a goal', 'a null role claim is refused');
select pg_temp.claims('{"sub":"11320000-0000-0000-0000-0000000000a1","role":["authenticated"]}');
select throws_ok($$ select public.submit_goal('11321111-0000-0000-0000-000000000001', 'array role') $$,
  '42501', 'a human session is required to submit a goal', 'a non-string role claim is refused');

-- 6. Nothing was written by any refused call: only the two accepted goals exist.
reset role;
select is((select count(*)::int from public.goals where workspace_id = '11321111-0000-0000-0000-000000000001'), 2,
  'only the baseline goal and the nested-claim goal were stored');
select is((select count(*)::int from public.tasks where workspace_id = '11321111-0000-0000-0000-000000000001' and goal_id is not null), 2,
  'only those two goals have a Manager task');

select * from finish();
rollback;
