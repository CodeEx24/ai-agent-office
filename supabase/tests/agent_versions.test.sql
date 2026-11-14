-- AGO-89: edit, duplicate and archive agents (public.update_agent, duplicate_agent, archive_agent,
-- unarchive_agent, agent_versions, the tasks guard).
--   AC1  edits are versioned and audited: a version row per change, written by a trigger, immutable
--   AC2  archived agents cannot receive tasks (and cannot be edited or duplicated)
--   AC3  a duplicate copies skills and capabilities but starts in Strict mode
--   +    owners only (member, viewer and outsider refused, also on direct writes), optimistic lock,
--        worker writes (status) leave no version, cross-workspace isolation
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('89000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89-o@example.test'),
  ('89000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89-m@example.test'),
  ('89000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89-v@example.test'),
  ('89000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago89-b@example.test');
insert into public.workspaces (id, name) values
  ('89aaaaaa-0000-4000-8000-000000000001', 'AGO-89 A'),
  ('89bbbbbb-0000-4000-8000-000000000001', 'AGO-89 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('89000000-0000-4000-8000-0000000001a1', '89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-00000000000a', 'owner'),
  ('89000000-0000-4000-8000-0000000001a2', '89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-00000000000c', 'member'),
  ('89000000-0000-4000-8000-0000000001a3', '89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-00000000000d', 'viewer'),
  ('89000000-0000-4000-8000-0000000001b1', '89bbbbbb-0000-4000-8000-000000000001', '89000000-0000-4000-8000-00000000000b', 'owner');
-- s = source (deliberately NOT strict, to prove a copy is), x = to be archived, w = worker-touched, z = scratch, bb = B's agent
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents, mode) values
  ('89000000-0000-4000-8000-0000000002a1', '89aaaaaa-0000-4000-8000-000000000001', 'Source', 'Researcher', 'claude-haiku-5-5', 'Find sources.', 500, 'permissive'),
  ('89000000-0000-4000-8000-0000000002a2', '89aaaaaa-0000-4000-8000-000000000001', 'Archivable', 'Writer', 'claude-haiku-5-5', 'Write.', 300, 'strict'),
  ('89000000-0000-4000-8000-0000000002a3', '89aaaaaa-0000-4000-8000-000000000001', 'Worker touched', 'Ops', 'claude-haiku-5-5', 'Run.', 200, 'strict'),
  ('89000000-0000-4000-8000-0000000002a4', '89aaaaaa-0000-4000-8000-000000000001', 'Scratch', 'Temp', 'claude-haiku-5-5', 'Temp.', 100, 'strict'),
  ('89000000-0000-4000-8000-0000000002b1', '89bbbbbb-0000-4000-8000-000000000001', 'B agent', 'Other', 'claude-haiku-5-5', 'Other.', 100, 'strict');
insert into public.skills (id, workspace_id, name, body) values
  ('89000000-0000-4000-8000-0000000003a1', '89aaaaaa-0000-4000-8000-000000000001', 'skill-a', 'one');
insert into public.agent_skills (workspace_id, agent_id, skill_id) values
  ('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', '89000000-0000-4000-8000-0000000003a1');
-- the catalog is seeded per workspace by the AGO-125 trigger
create temp table t_keys as
  select (select key from public.capabilities where workspace_id = '89aaaaaa-0000-4000-8000-000000000001' and tier < 3 order by key limit 1) as low,
         (select key from public.capabilities where workspace_id = '89aaaaaa-0000-4000-8000-000000000001' and tier < 3 order by key offset 1 limit 1) as low2,
         (select key from public.capabilities where workspace_id = '89aaaaaa-0000-4000-8000-000000000001' and tier >= 3 order by key limit 1) as high;
grant select on t_keys to authenticated;
insert into public.agent_capabilities (workspace_id, agent_id, capability, tier, mode, granted_by)
select '89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', c.key, c.tier, m.mode, '89000000-0000-4000-8000-0000000001a1'
  from (values ((select low from t_keys), 'automatic'), ((select low2 from t_keys), 'automatic'), ((select high from t_keys), 'approval')) as m(key, mode)
  join public.capabilities c on c.workspace_id = '89aaaaaa-0000-4000-8000-000000000001' and c.key = m.key;
-- a task assigned to x BEFORE it is archived: it must keep its assignment
insert into public.tasks (id, workspace_id, title, agent_id) values
  ('89000000-0000-4000-8000-0000000006a1', '89aaaaaa-0000-4000-8000-000000000001', 'Old task', '89000000-0000-4000-8000-0000000002a2'),
  ('89000000-0000-4000-8000-0000000006a2', '89aaaaaa-0000-4000-8000-000000000001', 'Loose task', null);

-- 1-4. AC1: every agent got a version row on insert (the trigger), and the columns exist
select is((select count(*)::int from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1'), 1, 'AC1: inserting an agent appends version 1');
select is((select change_kind || '/' || version from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1'), 'create/1', 'AC1: it is a create row at version 1');
select is((select thinking_effort from public.agents where id = '89000000-0000-4000-8000-0000000002a1'), 'medium', 'thinking effort defaults to medium');
select throws_ok($$update public.agents set thinking_effort = 'extreme' where id = '89000000-0000-4000-8000-0000000002a4'$$, '23514', null, 'thinking effort is limited to low, medium and high');

-- 5-6. worker writes leave no version
update public.agents set status = 'working' where id = '89000000-0000-4000-8000-0000000002a3';
select is((select count(*)::int from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a3'), 1, 'a status change (the worker) appends no version');
select is((select version from public.agents where id = '89000000-0000-4000-8000-0000000002a3'), 1, 'and does not move the version');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"89000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

-- 7-14. AC1: an owner edits, with an optimistic lock
create temp table t_edit as
  select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 1,
    'Source', 'Lead researcher', 'claude-haiku-5-5', 'high', 'Find better sources.', 500) as version;
grant select on t_edit to authenticated;
select is((select version from t_edit), 2, 'AC1: an edit returns the new version');
select is((select version from public.agents where id = '89000000-0000-4000-8000-0000000002a1'), 2, 'AC1: the agent is now at version 2');
select is((select change_kind || '/' || array_to_string(changed_fields, ',') from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1' and version = 2),
  'edit/role,thinking_effort,prompt', 'AC1: the version row names exactly the fields that changed');
select is((select prompt || '|' || role || '|' || thinking_effort from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1' and version = 2),
  'Find better sources.|Lead researcher|high', 'AC1: the version row holds the new settings');
select is((select changed_by from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1' and version = 2),
  '89000000-0000-4000-8000-0000000001a1'::uuid, 'AC1 audit: the row names the owner member who made the change');
select is((select version from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1' and version = 1 and prompt = 'Find sources.'), 1, 'AC1: version 1 still holds the old text');
select is(public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2,
    'Source', 'Lead researcher', 'claude-haiku-5-5', 'high', 'Find better sources.', 500), 2, 'saving without changes returns the same version');
select is((select count(*)::int from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1'), 2, 'and appends no row');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 1, 'Source', 'r', 'm', 'low', 'p', 100)$$,
  '40001', null, 'a stale edit (old version) is refused');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, 'Source', 'r', 'm', 'extreme', 'p', 100)$$,
  '22023', null, 'an unknown thinking effort is refused');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, 'Source', 'r', 'm', 'low', 'p', 5001)$$,
  '22023', null, 'a budget above the cap is refused');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, '  ', 'r', 'm', 'low', 'p', 100)$$,
  '22023', null, 'a blank name is refused');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, 'Archivable', 'r', 'm', 'low', 'p', 100)$$,
  '23505', null, 'a name another agent already uses is refused');
select is((select version from public.agents where id = '89000000-0000-4000-8000-0000000002a1'), 2, 'refused edits changed nothing (version still 2)');

-- 21-24. AC3: duplicate copies skills and capabilities but starts in Strict mode
create temp table t_copy as
  select public.duplicate_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 'Source (copy)') as id;
grant select on t_copy to authenticated;
select is((select mode from public.agents where id = (select id from t_copy)), 'strict', 'AC3: the copy starts in Strict mode, although the source is not');
select is((select role || '/' || model || '/' || thinking_effort || '/' || daily_budget_cents || '/' || prompt from public.agents where id = (select id from t_copy)),
  'Lead researcher/claude-haiku-5-5/high/500/Find better sources.', 'AC3: role, model, thinking effort, budget and prompt are copied');
select is((select count(*)::int from public.agent_skills where agent_id = (select id from t_copy) and skill_id = '89000000-0000-4000-8000-0000000003a1'), 1, 'AC3: the skill is copied');
select is((select count(*)::int from public.agent_capabilities where agent_id = (select id from t_copy)), 3, 'AC3: all three capabilities are copied');
select is((select mode from public.agent_capabilities where agent_id = (select id from t_copy) and capability = (select high from t_keys)), 'approval', 'AC3: a tier 3+ capability is still approval');
select is((select granted_by from public.agent_capabilities where agent_id = (select id from t_copy) limit 1), '89000000-0000-4000-8000-0000000001a1'::uuid, 'AC3: the copied grants are attributed to the owner who duplicated');
select is((select change_kind || '/' || version from public.agent_versions where agent_id = (select id from t_copy)), 'create/1', 'the copy has its own version history');
select is((select count(*)::int from public.agent_skills where agent_id = '89000000-0000-4000-8000-0000000002a1'), 1, 'the source keeps its skill and capabilities');
select throws_ok($$select public.duplicate_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 'Source (copy)')$$,
  '23505', null, 'a duplicate name is refused');
-- a capability disabled in the catalog is skipped, not copied
update public.capabilities set enabled = false where workspace_id = '89aaaaaa-0000-4000-8000-000000000001' and key = (select low2 from t_keys);
create temp table t_copy2 as
  select public.duplicate_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 'Source (copy 2)') as id;
grant select on t_copy2 to authenticated;
select is((select count(*)::int from public.agent_capabilities where agent_id = (select id from t_copy2)), 2, 'a capability that is disabled now is not copied');

-- 33-36. AC2: archive, and an archived agent cannot receive tasks
select lives_ok($$select public.archive_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2')$$, 'an owner archives an agent');
select is((select change_kind || '/' || array_to_string(changed_fields, ',') from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a2' and version = 2),
  'archive/archived_at', 'AC1: archiving is versioned and audited');
select throws_ok($$insert into public.tasks (workspace_id, title, agent_id) values ('89aaaaaa-0000-4000-8000-000000000001', 'New', '89000000-0000-4000-8000-0000000002a2')$$,
  '55000', null, 'AC2: a new task cannot be assigned to an archived agent');
select throws_ok($$update public.tasks set agent_id = '89000000-0000-4000-8000-0000000002a2' where id = '89000000-0000-4000-8000-0000000006a2'$$,
  '55000', null, 'AC2: an existing task cannot be re-assigned to an archived agent');
select lives_ok($$update public.tasks set title = 'Old task, renamed' where id = '89000000-0000-4000-8000-0000000006a1'$$,
  'a task assigned before the archive can still be edited (history is kept)');
select throws_ok($$select public.archive_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2')$$, '55000', null, 'archiving twice is refused');
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2', 2, 'Archivable', 'r', 'm', 'low', 'p', 100)$$,
  '55000', null, 'an archived agent cannot be edited');
select throws_ok($$select public.duplicate_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2', 'Nope')$$, '55000', null, 'an archived agent cannot be duplicated');
select throws_ok($$update public.agents set prompt = 'sneaky' where id = '89000000-0000-4000-8000-0000000002a2'$$, '55000', null, 'a direct edit of an archived agent is refused too');
-- unarchive
select lives_ok($$select public.unarchive_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2')$$, 'an owner unarchives an agent');
select is((select change_kind from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a2' and version = 3), 'unarchive', 'AC1: unarchiving is versioned');
select lives_ok($$update public.tasks set agent_id = '89000000-0000-4000-8000-0000000002a2' where id = '89000000-0000-4000-8000-0000000006a2'$$, 'after unarchiving the agent can receive tasks again');
select throws_ok($$select public.unarchive_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a2')$$, '55000', null, 'unarchiving an active agent is refused');

-- 46-47. isolation: another workspace's agent
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002b1', 1, 'x', 'r', 'm', 'low', 'p', 100)$$,
  'P0002', null, 'an agent of another workspace is not found through my workspace');
select throws_ok($$select public.update_agent('89bbbbbb-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002b1', 1, 'x', 'r', 'm', 'low', 'p', 100)$$,
  '42501', null, 'an owner of A cannot edit in workspace B');
select is((select count(*)::int from public.agent_versions where workspace_id = '89bbbbbb-0000-4000-8000-000000000001'), 0, 'an owner of A reads none of B''s versions');

-- 49-54. members and viewers decide nothing: refused through the functions and through direct writes
select set_config('request.jwt.claims', '{"sub":"89000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, 'Source', 'r', 'm', 'low', 'p', 100)$$, '42501', null, 'a member cannot edit an agent');
select throws_ok($$select public.duplicate_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 'Member copy')$$, '42501', null, 'a member cannot duplicate an agent');
select throws_ok($$select public.archive_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1')$$, '42501', null, 'a member cannot archive an agent');
update public.agents set prompt = 'member wrote this' where id = '89000000-0000-4000-8000-0000000002a1';
select is((select prompt from public.agents where id = '89000000-0000-4000-8000-0000000002a1'), 'Find better sources.',
  'a member''s direct update of an agent changes no row (owner-only policy)');
update public.agents set archived_at = now() where id = '89000000-0000-4000-8000-0000000002a1';
select is((select archived_at is null from public.agents where id = '89000000-0000-4000-8000-0000000002a1'), true,
  'a member cannot archive an agent with a direct update either');
select is((select count(*)::int from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1'), 2, 'a member can read the version history');
select set_config('request.jwt.claims', '{"sub":"89000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.update_agent('89aaaaaa-0000-4000-8000-000000000001', '89000000-0000-4000-8000-0000000002a1', 2, 'Source', 'r', 'm', 'low', 'p', 100)$$, '42501', null, 'a viewer cannot edit an agent');

-- 56-58. owners cannot touch the server-owned columns either
select set_config('request.jwt.claims', '{"sub":"89000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$update public.agents set mode = 'permissive' where id = '89000000-0000-4000-8000-0000000002a1'$$, '42501', null, 'nobody can change mode through the API');
select throws_ok($$update public.agents set version = 99 where id = '89000000-0000-4000-8000-0000000002a1'$$, '42501', null, 'nobody can set the version through the API');
select throws_ok($$update public.agent_versions set prompt = 'tampered' where agent_id = '89000000-0000-4000-8000-0000000002a1'$$, '42501', null, 'versions cannot be updated through the API');

-- 59-60. immutable for every role, service_role and postgres included
reset role;
select throws_ok($$update public.agent_versions set prompt = 'tampered' where agent_id = '89000000-0000-4000-8000-0000000002a1'$$, '42501', null, 'versions cannot be updated by any role');
select throws_ok($$delete from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a1'$$, '42501', null, 'versions cannot be deleted while the agent exists');
select throws_ok($$truncate public.agent_versions$$, '42501', null, 'versions cannot be truncated');
-- deleting an agent that has no other history cascades its versions (the FK), nothing else may
delete from public.agents where id = '89000000-0000-4000-8000-0000000002a4';
select is((select count(*)::int from public.agent_versions where agent_id = '89000000-0000-4000-8000-0000000002a4'), 0, 'deleting an agent removes its versions with it (cascade)');

select * from finish();
rollback;
