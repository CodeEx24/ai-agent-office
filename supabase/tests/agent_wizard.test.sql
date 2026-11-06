-- AGO-141: the agent creation wizard (public.create_agent).
--   AC1  valid input creates an agent in Strict mode, with its skills and capability grants, in one transaction
--   +    only owners create; tier 3 and 4 grants are never automatic; other workspaces' skills are refused;
--        a failure leaves nothing behind
-- Run: pnpm exec supabase test db (inside the db lock). Not run until the schema slot is granted.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('14100000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago141-o@example.test'),
  ('14100000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago141-m@example.test'),
  ('14100000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago141-v@example.test'),
  ('14100000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago141-b@example.test');
insert into public.workspaces (id, name) values
  ('141aaaaa-0000-4000-8000-000000000001', 'AGO-141 A'),
  ('141bbbbb-0000-4000-8000-000000000001', 'AGO-141 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('14100000-0000-4000-8000-0000000001a1', '141aaaaa-0000-4000-8000-000000000001', '14100000-0000-4000-8000-00000000000a', 'owner'),
  ('14100000-0000-4000-8000-0000000001a2', '141aaaaa-0000-4000-8000-000000000001', '14100000-0000-4000-8000-00000000000c', 'member'),
  ('14100000-0000-4000-8000-0000000001a3', '141aaaaa-0000-4000-8000-000000000001', '14100000-0000-4000-8000-00000000000d', 'viewer'),
  ('14100000-0000-4000-8000-0000000001b1', '141bbbbb-0000-4000-8000-000000000001', '14100000-0000-4000-8000-00000000000b', 'owner');
insert into public.skills (id, workspace_id, name, body) values
  ('14100000-0000-4000-8000-0000000003a1', '141aaaaa-0000-4000-8000-000000000001', 'skill-a', 'one'),
  ('14100000-0000-4000-8000-0000000003b1', '141bbbbb-0000-4000-8000-000000000001', 'skill-b', 'bee');
-- the catalog is seeded per workspace by the AGO-125 trigger: use a tier 0 and a tier 3+ key from it
create temp table t_keys as
  select (select key from public.capabilities where workspace_id = '141aaaaa-0000-4000-8000-000000000001' and tier = 0 order by key limit 1) as low,
         (select key from public.capabilities where workspace_id = '141aaaaa-0000-4000-8000-000000000001' and tier >= 3 order by key limit 1) as high;
grant select on t_keys to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"14100000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

-- 1-9. AC1: an owner creates an agent with skills and capabilities
create temp table t_agent as
  select public.create_agent(
    '141aaaaa-0000-4000-8000-000000000001', 'Scout', 'Researcher', 'claude-haiku-5-5', 'Find sources.', 500,
    array['14100000-0000-4000-8000-0000000003a1']::uuid[],
    (select jsonb_build_array(jsonb_build_object('key', low, 'mode', 'automatic'), jsonb_build_object('key', high, 'mode', 'approval')) from t_keys)
  ) as id;
grant select on t_agent to authenticated;
select is((select count(*)::int from public.agents where id = (select id from t_agent)), 1, 'AC1: the agent exists');
select is((select mode from public.agents where id = (select id from t_agent)), 'strict', 'AC1: it was created in Strict mode');
select is((select role || '/' || model || '/' || daily_budget_cents from public.agents where id = (select id from t_agent)), 'Researcher/claude-haiku-5-5/500', 'role, model and daily budget are stored');
select is((select count(*)::int from public.agent_skills where agent_id = (select id from t_agent)), 1, 'the skill is assigned');
select is((select count(*)::int from public.agent_capabilities where agent_id = (select id from t_agent)), 2, 'both capabilities are granted');
select is((select mode from public.agent_capabilities where agent_id = (select id from t_agent) and capability = (select low from t_keys)), 'automatic', 'a low tier capability can be automatic');
select is((select mode from public.agent_capabilities where agent_id = (select id from t_agent) and capability = (select high from t_keys)), 'approval', 'a tier 3+ capability is approval');
select is((select tier >= 3 from public.agent_capabilities where agent_id = (select id from t_agent) and capability = (select high from t_keys)), true, 'the tier comes from the catalog');
select is((select granted_by from public.agent_capabilities where agent_id = (select id from t_agent) limit 1), '14100000-0000-4000-8000-0000000001a1'::uuid, 'the grant is attributed to the owner member');

-- 10-16. refusals leave nothing behind
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Loose', 'R', 'm', 'p', 500, '{}', jsonb_build_array(jsonb_build_object('key', (select high from t_keys), 'mode', 'automatic')))$$,
  '22023', null, 'a tier 3+ capability cannot be automatic');
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Foreign', 'R', 'm', 'p', 500, array['14100000-0000-4000-8000-0000000003b1']::uuid[], '[]')$$,
  'P0002', null, 'another workspace''s skill is refused');
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Nocap', 'R', 'm', 'p', 500, '{}', '[{"key":"no.such","mode":"approval"}]')$$,
  'P0002', null, 'an unknown capability is refused');
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Rich', 'R', 'm', 'p', 5001, '{}', '[]')$$,
  '22023', null, 'a budget above the cap is refused');
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Free', 'R', 'm', 'p', 0, '{}', '[]')$$,
  '22023', null, 'a zero budget is refused');
select is((select count(*)::int from public.agents where name in ('Loose', 'Foreign', 'Nocap', 'Rich', 'Free')), 0, 'a refused call leaves no agent behind (atomic)');
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'Scout', 'R', 'm', 'p', 500, '{}', '[]')$$,
  '23505', null, 'a duplicate name is refused');

-- 17-18. direct writes cannot set mode, and a tier 3+ row cannot be automatic
select throws_ok($$insert into public.agents (workspace_id, name, mode) values ('141aaaaa-0000-4000-8000-000000000001', 'Sneaky', 'permissive')$$,
  '42501', null, 'mode is not writable through the API');
select throws_ok($$insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode, granted_by) values ('141aaaaa-0000-4000-8000-000000000001', (select id from t_agent), 'x.y', 3, 'automatic', '14100000-0000-4000-8000-0000000001a1')$$,
  '23514', null, 'the CHECK refuses an automatic tier 3 grant');

-- 19-23. other roles and workspaces
select set_config('request.jwt.claims', '{"sub":"14100000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'ByMember', 'R', 'm', 'p', 500, '{}', '[]')$$,
  '42501', null, 'a member cannot create an agent');
select throws_ok($$insert into public.agents (workspace_id, name) values ('141aaaaa-0000-4000-8000-000000000001', 'DirectMember')$$,
  '42501', null, 'a member cannot insert an agent directly either');
select set_config('request.jwt.claims', '{"sub":"14100000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'ByViewer', 'R', 'm', 'p', 500, '{}', '[]')$$,
  '42501', null, 'a viewer cannot create an agent');
select set_config('request.jwt.claims', '{"sub":"14100000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'ByStranger', 'R', 'm', 'p', 500, '{}', '[]')$$,
  '42501', null, 'an owner of another workspace cannot create an agent here');

-- 24. anon cannot call it
reset role;
set local role anon;
select throws_ok($$select public.create_agent('141aaaaa-0000-4000-8000-000000000001', 'ByAnon', 'R', 'm', 'p', 500, '{}', '[]')$$,
  '42501', null, 'anon cannot call create_agent');
reset role;

select * from finish();
rollback;
