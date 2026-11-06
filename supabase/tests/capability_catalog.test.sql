-- AGO-125: the capability catalog.
--   AC1  every workspace has the 12 starter capabilities (seeded for existing and new workspaces, idempotent)
--   AC2  tier 3 and 4 cannot be automatic, in data (CHECK), even for the table owner
--   AC3  members and viewers read the catalog; owners change only enabled and description; isolation holds
-- The AGO-107 catalog test (rls_catalog.test.sql) covers RLS, grants and the pinned search_path for this
-- table automatically.
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- fixtures (as postgres): o = owner of A, m = member of A, v = viewer of A, b = owner of B
insert into auth.users (id, instance_id, aud, role, email) values
  ('12500000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago125-o@example.test'),
  ('12500000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago125-m@example.test'),
  ('12500000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago125-v@example.test'),
  ('12500000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago125-b@example.test');
insert into public.workspaces (id, name) values
  ('125aaaaa-0000-4000-8000-000000000001', 'AGO-125 A'),
  ('125bbbbb-0000-4000-8000-000000000001', 'AGO-125 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('12500000-0000-4000-8000-0000000001a1', '125aaaaa-0000-4000-8000-000000000001', '12500000-0000-4000-8000-00000000000a', 'owner'),
  ('12500000-0000-4000-8000-0000000001a2', '125aaaaa-0000-4000-8000-000000000001', '12500000-0000-4000-8000-00000000000c', 'member'),
  ('12500000-0000-4000-8000-0000000001a3', '125aaaaa-0000-4000-8000-000000000001', '12500000-0000-4000-8000-00000000000d', 'viewer'),
  ('12500000-0000-4000-8000-0000000001b1', '125bbbbb-0000-4000-8000-000000000001', '12500000-0000-4000-8000-00000000000b', 'owner');

-- 1-6. AC1: the starter catalog arrives with every new workspace
select has_table('public', 'capabilities', 'AC1: public.capabilities exists');
select is((select count(*)::int from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001'), 12,
  'AC1: a new workspace gets exactly 12 starter capabilities (trigger)');
select is((select count(*)::int from public.capabilities where workspace_id = '125bbbbb-0000-4000-8000-000000000001'), 12,
  'AC1: so does a second workspace');
select results_eq(
  $$select key, tier::int, scope, default_mode from public.capabilities
    where workspace_id = '125aaaaa-0000-4000-8000-000000000001' order by tier, key$$,
  $$values
    ('vault.read'::text, 0, 'workspace'::text, 'automatic'::text),
    ('vault.read_private', 0, 'agent', 'automatic'),
    ('tasks.manage', 1, 'workspace', 'automatic'),
    ('web.search', 1, 'external', 'automatic'),
    ('vault.write_own', 2, 'agent', 'approval'),
    ('vault.write_shared', 2, 'workspace', 'approval'),
    ('code.run', 3, 'sandbox', 'approval'),
    ('integration.write', 3, 'external', 'approval'),
    ('message.send_outbound', 3, 'external', 'approval'),
    ('web.browse', 3, 'external', 'approval'),
    ('data.delete_irreversible', 4, 'workspace', 'approval'),
    ('payments.execute', 4, 'external', 'approval')$$,
  'AC1: the 12 starter capabilities, their tiers, scopes and defaults');
select is((select count(distinct tier)::int from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001'), 5,
  'AC1: the starter catalog covers tiers 0 to 4');
select is((select count(*)::int from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and enabled), 12,
  'AC1: every starter capability starts enabled');

-- 7-9. idempotent seeding never overwrites an edit or duplicates a row
update public.capabilities set enabled = false, description = 'edited' where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'web.search';
select lives_ok($$select private.seed_workspace_capabilities('125aaaaa-0000-4000-8000-000000000001')$$, 'AC1: re-seeding a workspace succeeds');
select is((select count(*)::int from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001'), 12, 'AC1: re-seeding adds no duplicates');
select is((select enabled::text || '/' || description from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'web.search'),
  'false/edited', 'AC1: re-seeding does not overwrite an owner''s edit');

-- 10-17. AC2: tier 3 and 4 can never be automatic, in data (as postgres, so RLS and grants are not what stops it)
select throws_ok(
  $$update public.capabilities set default_mode = 'automatic' where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'payments.execute'$$,
  '23514', null, 'AC2: a tier 4 capability cannot be set to automatic');
select throws_ok(
  $$update public.capabilities set default_mode = 'automatic' where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'code.run'$$,
  '23514', null, 'AC2: a tier 3 capability cannot be set to automatic');
select throws_ok(
  $$update public.capabilities set tier = 4 where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'vault.read'$$,
  '23514', null, 'AC2: raising an automatic capability to tier 4 is rejected while it is automatic');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.tier4_auto', 'X', 4, 'external', 'automatic')$$,
  '23514', null, 'AC2: a new tier 4 capability cannot be inserted as automatic');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.tier3_auto', 'X', 3, 'external', 'automatic')$$,
  '23514', null, 'AC2: a new tier 3 capability cannot be inserted as automatic');
select lives_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.tier4_approval', 'X', 4, 'external', 'approval')$$,
  'AC2 (control): a tier 4 capability with approval is accepted');
select lives_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.tier2_auto', 'X', 2, 'agent', 'automatic')$$,
  'AC2 (control): a tier 2 capability may be automatic');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.tier5', 'X', 5, 'external', 'approval')$$,
  '23514', null, 'AC2: tier above 4 is rejected');

-- 18-21. shape checks
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.bad_scope', 'X', 1, 'galaxy', 'approval')$$,
  '23514', null, 'a scope outside workspace/agent/external/sandbox is rejected');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'x.bad_mode', 'X', 1, 'agent', 'always')$$,
  '23514', null, 'a default outside automatic/approval is rejected');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'NotDotted', 'X', 1, 'agent', 'approval')$$,
  '23514', null, 'a key that is not lowercase dotted is rejected');
select throws_ok(
  $$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
    values ('125aaaaa-0000-4000-8000-000000000001', 'vault.read', 'Dup', 0, 'workspace', 'automatic')$$,
  '23505', null, 'a key is unique per workspace');

-- 22-33. AC3: a viewer reads, nobody below owner writes
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"12500000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select is((select count(*)::int from public.capabilities), 14, 'AC3: a viewer reads their workspace''s whole catalog (12 + 2 test rows) and nothing of B');
select is((select count(*)::int from public.capabilities where workspace_id = '125bbbbb-0000-4000-8000-000000000001'), 0, 'AC3: a viewer of A cannot read B''s catalog');
with u as (update public.capabilities set enabled = false where key = 'vault.read' returning 1)
select is((select count(*)::int from u), 0, 'AC3: a viewer''s update changes no row');
select throws_ok($$insert into public.capabilities (workspace_id, key, name, tier, scope, default_mode)
  values ('125aaaaa-0000-4000-8000-000000000001', 'v.new', 'N', 0, 'agent', 'automatic')$$, '42501', null, 'AC3: a viewer cannot insert');

select set_config('request.jwt.claims', '{"sub":"12500000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select is((select count(*)::int from public.capabilities), 14, 'AC3: a member reads the catalog');
with u as (update public.capabilities set enabled = false where key = 'vault.read' returning 1)
select is((select count(*)::int from u), 0, 'AC3: a member''s update changes no row');

select set_config('request.jwt.claims', '{"sub":"12500000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.capabilities), 14, 'AC3: an owner reads the catalog');
with u as (update public.capabilities set enabled = false, description = 'owner edit' where key = 'vault.read' returning 1)
select is((select count(*)::int from u), 1, 'AC3: an owner can change enabled and description');
select throws_ok($$update public.capabilities set tier = 0 where key = 'payments.execute'$$, '42501', null, 'AC3: not even an owner can change a tier through the API');
select throws_ok($$update public.capabilities set default_mode = 'automatic' where key = 'code.run'$$, '42501', null, 'AC3: not even an owner can change the default through the API');
select throws_ok($$update public.capabilities set key = 'renamed.key' where key = 'vault.read'$$, '42501', null, 'AC3: not even an owner can rename a key through the API');
select throws_ok($$delete from public.capabilities where key = 'vault.read'$$, '42501', null, 'AC3: not even an owner can delete a capability through the API');

-- 34-36. an owner of B cannot touch A's catalog
select set_config('request.jwt.claims', '{"sub":"12500000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001'), 0, 'isolation: an owner of B cannot read A''s catalog');
with u as (update public.capabilities set enabled = false where workspace_id = '125aaaaa-0000-4000-8000-000000000001' returning 1)
select is((select count(*)::int from u), 0, 'isolation: an owner of B cannot update A''s catalog');
select is((select count(*)::int from public.capabilities), 12, 'isolation: an owner of B sees exactly their own 12');

-- 37-38. the seeding functions cannot be called by a signed-in user, and anon sees nothing
select throws_ok($$select private.seed_workspace_capabilities('125bbbbb-0000-4000-8000-000000000001')$$, '42501', null,
  'a signed-in user cannot call the seeding function');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.capabilities$$, '42501', null, 'anon cannot read the catalog');

-- 39-40. owner's edit stuck, and the high-tier invariant survives it (as postgres)
reset role;
select is((select enabled::text || '/' || description from public.capabilities where workspace_id = '125aaaaa-0000-4000-8000-000000000001' and key = 'vault.read'),
  'false/owner edit', 'the owner''s safe edit was stored');
select is((select count(*)::int from public.capabilities where tier >= 3 and default_mode = 'automatic'), 0,
  'AC2: no capability anywhere is tier 3 or 4 and automatic');

select * from finish();
rollback;
