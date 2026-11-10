-- AGO-122: deterministic local seed data. Loaded by `supabase db reset` (config.toml [db.seed]) and
-- re-applied to the running local stack by `pnpm db:seed`. LOCAL ONLY: never run against a hosted project.
--
-- Idempotent: fixed ids plus bare `on conflict do nothing` (it also absorbs the (workspace_id, name)
-- unique keys), so a second run changes nothing. It never overwrites rows a developer edited.
-- The ids are mirrored in packages/shared/src/seed/seed-ids.ts (a test fails if the two drift).
--
-- Deliberately NOT seeded: run_events, runs, approvals, claims (nothing may fake history or a human
-- decision). Agents land in Strict mode with an idle status and tier 0 capabilities only.
-- The owner has no password and cannot sign in; tests and dev flows sign in as their own users.

begin;

insert into auth.users (id, instance_id, aud, role, email) values
  ('12200010-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'seed-owner@agent-office.local')
on conflict do nothing;

insert into public.workspaces (id, name) values
  ('12200001-0000-4000-8000-000000000001', 'Seed Workspace')
on conflict do nothing;

insert into public.members (id, workspace_id, user_id, role) values
  ('12200011-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   '12200010-0000-4000-8000-000000000001', 'owner')
on conflict do nothing;

-- `model` must be on the shared allowlist (AGENT_MODELS in packages/shared); AGO-94 fails a run whose
-- agent has an empty or unknown model, so a seed agent without one could never run.
insert into public.agents (id, workspace_id, name, description, model, mode, status) values
  ('12200020-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   'Scout', 'Researches topics and files findings as vault notes.', 'claude-sonnet-5-5', 'strict', 'idle'),
  ('12200020-0000-4000-8000-000000000002', '12200001-0000-4000-8000-000000000001',
   'Scribe', 'Drafts and tidies Markdown notes and documents.', 'claude-sonnet-5-5', 'strict', 'idle'),
  ('12200020-0000-4000-8000-000000000003', '12200001-0000-4000-8000-000000000001',
   'Reviewer', 'Reviews drafts and proposed changes; never approves its own work.', 'claude-sonnet-5-5', 'strict', 'idle')
on conflict do nothing;

insert into public.skills (id, workspace_id, name, description, body) values
  ('12200030-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   'research-summary', 'Summarise sources into a short briefing.',
   E'# Research summary\n\nRead the given sources and write a briefing with key points and open questions.'),
  ('12200030-0000-4000-8000-000000000002', '12200001-0000-4000-8000-000000000001',
   'note-writing', 'Write clear, linked Markdown notes.',
   E'# Note writing\n\nWrite one idea per note, with a title, short body and links to related notes.'),
  ('12200030-0000-4000-8000-000000000003', '12200001-0000-4000-8000-000000000001',
   'peer-review', 'Review a draft and list concrete issues.',
   E'# Peer review\n\nCheck a draft against its brief and list problems by severity. Do not approve.')
on conflict do nothing;

insert into public.agent_skills (id, workspace_id, agent_id, skill_id) values
  ('12200040-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000001', '12200030-0000-4000-8000-000000000001'),
  ('12200040-0000-4000-8000-000000000002', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000002', '12200030-0000-4000-8000-000000000002'),
  ('12200040-0000-4000-8000-000000000003', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000003', '12200030-0000-4000-8000-000000000003')
on conflict do nothing;

-- Tier 0 only, granted by the human owner.
insert into public.agent_capabilities (id, workspace_id, agent_id, capability, tier, granted_by) values
  ('12200050-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000001', 'vault.read', 0, '12200011-0000-4000-8000-000000000001'),
  ('12200050-0000-4000-8000-000000000002', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000002', 'vault.read', 0, '12200011-0000-4000-8000-000000000001'),
  ('12200050-0000-4000-8000-000000000003', '12200001-0000-4000-8000-000000000001',
   '12200020-0000-4000-8000-000000000003', 'vault.read', 0, '12200011-0000-4000-8000-000000000001')
on conflict do nothing;

insert into public.tasks (id, workspace_id, title, description, status, agent_id, created_by) values
  ('12200060-0000-4000-8000-000000000001', '12200001-0000-4000-8000-000000000001',
   'Research office layout options', 'Collect three reference layouts for the virtual office.', 'todo',
   '12200020-0000-4000-8000-000000000001', '12200011-0000-4000-8000-000000000001'),
  ('12200060-0000-4000-8000-000000000002', '12200001-0000-4000-8000-000000000001',
   'Draft the onboarding note', 'Write a one-page welcome note for new members.', 'todo',
   '12200020-0000-4000-8000-000000000002', '12200011-0000-4000-8000-000000000001'),
  ('12200060-0000-4000-8000-000000000003', '12200001-0000-4000-8000-000000000001',
   'Review the onboarding note', 'Review the draft once it exists and list issues.', 'todo',
   '12200020-0000-4000-8000-000000000003', '12200011-0000-4000-8000-000000000001'),
  ('12200060-0000-4000-8000-000000000004', '12200001-0000-4000-8000-000000000001',
   'Summarise weekly progress', 'Unassigned: a human picks who takes it.', 'todo',
   null, '12200011-0000-4000-8000-000000000001'),
  ('12200060-0000-4000-8000-000000000005', '12200001-0000-4000-8000-000000000001',
   'Tidy the vault index', 'Unassigned: group loose notes under topics.', 'todo',
   null, '12200011-0000-4000-8000-000000000001')
on conflict do nothing;

commit;
