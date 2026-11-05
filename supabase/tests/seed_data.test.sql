-- AGO-122: the local seed. Needs the seed loaded (`supabase db reset` does it, as does `pnpm db:seed`).
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

select is((select count(*)::int from public.workspaces where id = '12200001-0000-4000-8000-000000000001'), 1, 'seed: 1 workspace');
select is((select count(*)::int from public.members where workspace_id = '12200001-0000-4000-8000-000000000001' and role = 'owner' and removed_at is null), 1, 'seed: 1 active owner');
select is((select count(*)::int from public.agents where workspace_id = '12200001-0000-4000-8000-000000000001'), 3, 'seed: 3 agents');
select is((select count(*)::int from public.tasks where workspace_id = '12200001-0000-4000-8000-000000000001'), 5, 'seed: 5 tasks');
select cmp_ok((select count(*)::int from public.skills where workspace_id = '12200001-0000-4000-8000-000000000001'), '>=', 1, 'seed: starter skills');
select is((select count(*)::int from public.agent_skills where workspace_id = '12200001-0000-4000-8000-000000000001'), 3, 'seed: every agent has a starter skill');

select is((select count(*)::int from public.agents where workspace_id = '12200001-0000-4000-8000-000000000001' and (mode <> 'strict' or status <> 'idle')), 0, 'seed: agents land in strict mode, idle');
select is((select count(*)::int from public.agent_capabilities where workspace_id = '12200001-0000-4000-8000-000000000001' and tier > 1), 0, 'seed: no capability above tier 1');

-- nothing fakes history or a human decision
select is(
  (select count(*)::int from public.run_events where workspace_id = '12200001-0000-4000-8000-000000000001')
  + (select count(*)::int from public.runs where workspace_id = '12200001-0000-4000-8000-000000000001')
  + (select count(*)::int from public.approvals where workspace_id = '12200001-0000-4000-8000-000000000001'),
  0, 'seed: no run_events, runs or approvals');

select is((select email from auth.users where id = '12200010-0000-4000-8000-000000000001'), 'seed-owner@agent-office.local', 'seed: owner is a clearly local user');
select is((select count(*)::int from auth.users where id = '12200010-0000-4000-8000-000000000001' and encrypted_password is not null), 0, 'seed: owner has no password');

select * from finish();
rollback;
