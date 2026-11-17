-- AGO-194: public.import_agent_pack, the all-or-nothing agent pack import (pgTAP).
--   shape: SECURITY DEFINER with a fixed search_path, executable by authenticated only, pack_events.detail exists
--   principals: a member, a viewer, an owner of another workspace, an agent token claim, a session with no user and
--     the anon role are all refused; only the owner of the named workspace imports
--   input: a bad rule, checksum or plan shape is refused before anything is written
--   success: every agent lands strict, Tier 3 is never granted, a disabled agent is archived, exactly one
--     'import' event holds the checksum, the importing member and the per-agent outcome
--   atomic: a Tier 3 plan, a failing last agent, a stale name and an unknown skill or capability each leave zero rows
--     (no agent, skill, grant or event) behind
--   conflicts: a new skill version bumps the version and never overwrites in place; an archived agent is not updated
--   isolation: another workspace's agents and skills are never touched
-- Run: pnpm exec supabase test db (inside the db lock).
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

insert into auth.users (id, instance_id, aud, role, email) values
  ('19400000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-o@example.test'),
  ('19400000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-m@example.test'),
  ('19400000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-v@example.test'),
  ('19400000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ago194-b@example.test');
insert into public.workspaces (id, name) values
  ('194aaaaa-0000-4000-8000-000000000001', 'AGO-194 A'),
  ('194bbbbb-0000-4000-8000-000000000001', 'AGO-194 B');
insert into public.members (id, workspace_id, user_id, role) values
  ('19400000-0000-4000-8000-0000000001a1', '194aaaaa-0000-4000-8000-000000000001', '19400000-0000-4000-8000-00000000000a', 'owner'),
  ('19400000-0000-4000-8000-0000000001a2', '194aaaaa-0000-4000-8000-000000000001', '19400000-0000-4000-8000-00000000000c', 'member'),
  ('19400000-0000-4000-8000-0000000001a3', '194aaaaa-0000-4000-8000-000000000001', '19400000-0000-4000-8000-00000000000d', 'viewer'),
  ('19400000-0000-4000-8000-0000000001b1', '194bbbbb-0000-4000-8000-000000000001', '19400000-0000-4000-8000-00000000000b', 'owner');
-- Another workspace holds a skill and an agent with the same names the pack will use: they must stay as they are.
insert into public.skills (id, workspace_id, name, body) values
  ('19400000-0000-4000-8000-0000000003b1', '194bbbbb-0000-4000-8000-000000000001', 'Citing', 'B body');
insert into public.agents (id, workspace_id, name, role, model, prompt, daily_budget_cents) values
  ('19400000-0000-4000-8000-0000000002b1', '194bbbbb-0000-4000-8000-000000000001', 'Scout', 'B role', 'claude-haiku-5-5', 'b prompt', 100);

-- 1. Shape and privileges.
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'import_agent_pack'
              and p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('service_role', p.oid, 'execute')),
  1, 'import_agent_pack is SECURITY DEFINER, executable by authenticated only');
select is((select p.proconfig @> array['search_path=""'] from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'import_agent_pack'),
  true, 'import_agent_pack pins an empty search_path');
select has_column('public', 'pack_events', 'detail', 'pack_events has the import detail column');

-- 2. Principals that are refused.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'a member is refused');
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'a viewer is refused');
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'the owner of another workspace is refused');
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000a","role":"authenticated","agent_id":"19400000-0000-4000-8000-0000000002b1"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'a token carrying an agent claim is refused, even with an owner subject');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'a session with no signed-in user is refused');
set local role anon;
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '42501', null, 'the anon role cannot execute it');

-- 3. The owner: bad input is refused before anything is written.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"overwrite","agents":[],"skills":[]}'::jsonb)$$, '22023', null, 'an unknown conflict rule is refused');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', 'not-a-checksum',
  '{"rule":"skip","agents":[],"skills":[]}'::jsonb)$$, '22023', null, 'a checksum that is not 64 hex characters is refused');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64),
  '{"rule":"skip","agents":{}}'::jsonb)$$, '22023', null, 'a plan without agent and skill lists is refused');

-- 4. A successful import: one skill, one clean agent and one agent that failed the trifecta lint.
select lives_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"skip",
   "skills":[{"name":"Citing","action":"create","body":"Cite sources."}],
   "agents":[
     {"name":"Scout","action":"create","role":"Researcher","model":"claude-haiku-5-5","thinking_effort":"medium",
      "prompt":"Find sources.","daily_budget_cents":500,"capabilities":["vault.read"],"skills":["Citing"],
      "disabled_reason":null},
     {"name":"Risky","action":"create","role":"Sender","model":"claude-haiku-5-5","thinking_effort":"medium",
      "prompt":"Send mail.","daily_budget_cents":200,"capabilities":["web.search","vault.read"],"skills":[],
      "disabled_reason":"trifecta_combination"}]}
  $json$::jsonb)$$, 'an owner imports a pack');
select is((select count(*)::int from public.pack_events where kind = 'import'), 1, 'exactly one import event is written');
select is((select exported_by from public.pack_events where kind = 'import'),
  '19400000-0000-4000-8000-0000000001a1'::uuid, 'the event records the importing member, not a value from the plan');
select is((select checksum from public.pack_events where kind = 'import'), repeat('a', 64), 'the event carries the pack checksum');
select is((select agent_names from public.pack_events where kind = 'import'), array['Scout', 'Risky'], 'the event lists the agents in plan order');
select is((select (detail ->> 'disabled')::int from public.pack_events where kind = 'import'), 1, 'the event detail counts the disabled agent');
select is((select mode from public.agents where name = 'Scout' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  'strict', 'an imported agent starts in strict mode');
select is((select mode from public.agents where name = 'Risky' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  'strict', 'a disabled agent is strict too');
select isnt((select archived_at from public.agents where name = 'Risky' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  null, 'the agent that failed the lint is imported disabled (archived)');
select is((select archived_at from public.agents where name = 'Scout' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  null, 'a clean agent is active');
select is((select c.mode || ':' || c.tier from public.agent_capabilities c join public.agents a on a.id = c.agent_id
            where a.name = 'Scout' and a.workspace_id = '194aaaaa-0000-4000-8000-000000000001' and c.capability = 'vault.read'),
  'approval:0', 'a granted capability is approval mode with the tier read from the catalog');
select is((select count(*)::int from public.skills where name = 'Citing' and workspace_id = '194aaaaa-0000-4000-8000-000000000001' and version = 1),
  1, 'a new skill arrives as version 1');
select is((select count(*)::int from public.agent_skills s join public.agents a on a.id = s.agent_id
            where a.name = 'Scout' and a.workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  1, 'the agent is attached to the imported skill');

-- 5. All or nothing: each failure leaves no agent, skill, grant or event behind.
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('b', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Tier3","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":["code.run"],"skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, '40001', null, 'a Tier 3 capability in a plan is refused, never granted');
select is((select count(*)::int from public.agents where name = 'Tier3'), 0, 'the Tier 3 plan left no agent');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('c', 64), $json$
  {"rule":"skip",
   "skills":[{"name":"Fresh","action":"create","body":"x"}],
   "agents":[
     {"name":"Good","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
      "daily_budget_cents":100,"capabilities":["vault.read"],"skills":["Fresh"],"disabled_reason":null},
     {"name":"Bad","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
      "daily_budget_cents":0,"capabilities":[],"skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, '22023', null, 'a failing last agent fails the whole import');
select is((select count(*)::int from public.skills where name = 'Fresh') + (select count(*)::int from public.agents where name in ('Good', 'Bad')),
  0, 'the failing last agent left no skill and no earlier agent behind');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('d', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Scout","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":[],"skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, '40001', null, 'a name that now exists is a stale plan');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('d', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Ghost","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":["not.a.capability"],"skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, 'P0002', null, 'a capability outside the workspace catalog is refused');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('d', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Ghost","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":[],"skills":["No such skill"],"disabled_reason":null}]}
  $json$::jsonb)$$, 'P0002', null, 'a skill that does not exist is refused');
select is((select count(*)::int from public.pack_events where kind = 'import'), 1, 'no failed attempt wrote an event');

-- 6. Conflicts: a new skill version bumps the version, an agent update keeps strict mode, an archived agent is stale.
select lives_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('e', 64), $json$
  {"rule":"new_version",
   "skills":[{"name":"Citing","action":"new_version","body":"Cite with page numbers."}],
   "agents":[
     {"name":"Scout","action":"update","role":"Senior researcher","model":"claude-haiku-5-5","thinking_effort":"medium",
      "prompt":"Find sources.","daily_budget_cents":500,"capabilities":["vault.read"],"skills":["Citing"],
      "disabled_reason":null}]}
  $json$::jsonb)$$, 'a new_version import updates an agent and versions a skill');
select is((select version || ':' || body from public.skills where name = 'Citing' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  '2:Cite with page numbers.', 'the skill arrives as a new version, version 2');
select is((select role || ':' || mode from public.agents where name = 'Scout' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  'Senior researcher:strict', 'the agent was updated and is still strict');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('f', 64), $json$
  {"rule":"new_version","skills":[],"agents":[
   {"name":"Risky","action":"update","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":[],"skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, '40001', null, 'an archived agent is never updated by an import');

-- 6b. Hardening (fix round 2): explicit action validation, budget types, the trifecta on an update, clean event names.
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"new_version","skills":[],"agents":[
   {"name":"Scout","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":[],"skills":[]}]}
  $json$::jsonb)$$, '22023', null, 'an agent entry with no action is refused');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"new_version","skills":[],"agents":[
   {"name":"Scout","action":null,"role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":100,"capabilities":[],"skills":[]}]}
  $json$::jsonb)$$, '22023', null, 'an agent entry with a null action is refused');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"new_version","agents":[],"skills":[{"name":"Citing","body":"overwritten?"}]}
  $json$::jsonb)$$, '22023', null, 'a skill entry with no action is refused');
select is((select version || ':' || body from public.skills where name = 'Citing' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  '2:Cite with page numbers.', 'a skill with no action was not written');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Texty","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":"12","capabilities":[],"skills":[]}]}
  $json$::jsonb)$$, '22023', null, 'a budget given as text is refused with 22023, not a cast error');
select throws_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('a', 64), $json$
  {"rule":"skip","skills":[],"agents":[
   {"name":"Fraction","action":"create","role":"r","model":"claude-haiku-5-5","thinking_effort":"medium","prompt":"p",
    "daily_budget_cents":12.5,"capabilities":[],"skills":[]}]}
  $json$::jsonb)$$, '22023', null, 'a fractional budget is refused with 22023');

-- An update that completes the trifecta is archived: Scout already holds vault.read (private); the pack adds the
-- untrusted and outbound legs. Outbound is Tier 3 in the starter catalog, so the workspace lowers it for this test.
reset role;
update public.capabilities set tier = 2
 where workspace_id = '194aaaaa-0000-4000-8000-000000000001' and key = 'message.send_outbound';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19400000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('1', 64), $json$
  {"rule":"new_version","skills":[],"agents":[
   {"name":"Scout","action":"update","role":"Senior researcher","model":"claude-haiku-5-5","thinking_effort":"medium",
    "prompt":"Find sources.","daily_budget_cents":500,"capabilities":["web.search","message.send_outbound"],
    "skills":[],"disabled_reason":null}]}
  $json$::jsonb)$$, 'an update that completes the trifecta is applied');
select isnt((select archived_at from public.agents where name = 'Scout' and workspace_id = '194aaaaa-0000-4000-8000-000000000001'),
  null, 'the agent that holds all three trifecta legs after the update is archived');
select is((select detail -> 'agents' -> 0 ->> 'disabled_reason' from public.pack_events where checksum = repeat('1', 64)),
  'trifecta_combination', 'the event names the trifecta as the reason');

-- Names in the event carry no direction override or zero-width characters.
select lives_ok($$select public.import_agent_pack('194aaaaa-0000-4000-8000-000000000001', repeat('2', 64),
  jsonb_build_object('rule', 'skip', 'skills', '[]'::jsonb, 'agents', jsonb_build_array(jsonb_build_object(
    'name', 'Zed' || chr(8238) || 'x' || chr(8203), 'action', 'create', 'role', 'r', 'model', 'claude-haiku-5-5',
    'thinking_effort', 'medium', 'prompt', 'p', 'daily_budget_cents', 100, 'capabilities', '[]'::jsonb,
    'skills', '[]'::jsonb, 'disabled_reason', null))))$$, 'an agent name with bidi and zero-width characters is imported');
select is((select (agent_names::text || detail::text) ~ (chr(8238) || '|' || chr(8203)) from public.pack_events where checksum = repeat('2', 64)),
  false, 'the event row holds neither the direction override nor the zero-width space');

-- 7. Isolation: the other workspace was never touched.
reset role;
select is((select body || ':' || version from public.skills where id = '19400000-0000-4000-8000-0000000003b1'),
  'B body:1', 'the other workspace''s skill is untouched');
select is((select role from public.agents where id = '19400000-0000-4000-8000-0000000002b1'),
  'B role', 'the other workspace''s agent is untouched');
select is((select count(*)::int from public.pack_events where workspace_id = '194bbbbb-0000-4000-8000-000000000001'),
  0, 'no event was written for the other workspace');

select * from finish();
rollback;
