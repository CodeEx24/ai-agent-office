-- AGO-125: the capability catalog (EP-03). Per-workspace rows: key, name, risk tier 0-4, scope and default.
-- Builds on AGO-74 (workspaces), AGO-82 (private.is_member) and AGO-107 (per-command RLS and exact grants).
-- Rollback: supabase/rollbacks/20261106140001_ago_125_capability_catalog.down.sql
--
-- Decisions (full list in docs/tickets/AGO-125.md):
-- * The Master List of starter capabilities was not found in the repo or tracker. The 12 rows in
--   private.seed_workspace_capabilities() are the v1 source of truth. To amend the list, change that one
--   function in a new migration (and packages/shared/src/capabilities/starter-capabilities.ts, which a test
--   keeps in step with this file).
-- * The catalog is per workspace (workspace_id + RLS, required by the AGO-107 catalog test). Existing
--   workspaces are backfilled below; new ones are seeded by an AFTER INSERT trigger on workspaces.
-- * Humans decide: any member or viewer may read; only owners may write, and only the safe fields
--   `enabled` and `description`. key, name, tier, scope and default_mode are never in an INSERT or
--   UPDATE grant, so only migrations change them. Nobody can delete through the API.
-- * Tier 3 and 4 can never be automatic, in data: a CHECK constraint, so it also holds for service_role.

create table public.capabilities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key text not null check (char_length(key) <= 100 and key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  tier smallint not null check (tier between 0 and 4),
  scope text not null check (scope in ('workspace', 'agent', 'external', 'sandbox')),
  default_mode text not null check (default_mode in ('automatic', 'approval')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, key),
  constraint capabilities_high_tier_never_automatic check (tier < 3 or default_mode = 'approval')
);
comment on table public.capabilities is 'Capability catalog per workspace (AGO-125). Read by members and viewers; owners may only change enabled and description. Tier, scope and default change by migration only.';
comment on column public.capabilities.tier is 'Risk tier 0 (read only) to 4 (irreversible or costly). Tier 3 and 4 never run alone: see capabilities_high_tier_never_automatic.';
comment on column public.capabilities.scope is 'Where the capability acts: workspace, agent (its own data), external (outside the workspace) or sandbox.';
comment on column public.capabilities.default_mode is 'automatic or approval. Never automatic at tier 3 or 4 (CHECK). The policy engine (AGO-34) still decides per call.';

create trigger set_updated_at before update on public.capabilities
  for each row execute function private.set_updated_at();

alter table public.capabilities enable row level security;

revoke all on table public.capabilities from anon, authenticated;
grant select on public.capabilities to authenticated;
grant update (enabled, description) on public.capabilities to authenticated;

create policy capabilities_select_viewer on public.capabilities for select to authenticated
  using (private.is_member(workspace_id));
create policy capabilities_update_owner on public.capabilities for update to authenticated
  using (private.is_member(workspace_id, 'owner'))
  with check (private.is_member(workspace_id, 'owner'));

-- The v1 starter catalog. Idempotent: re-running adds missing rows and never overwrites an owner's edits.
-- Runs as the table owner so it bypasses RLS; nobody can call it (see revoke below).
create function private.seed_workspace_capabilities(p_workspace_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.capabilities (workspace_id, key, name, description, tier, scope, default_mode)
  select p_workspace_id, v.key, v.name, v.description, v.tier, v.scope, v.default_mode
  from (values
    ('vault.read', 'Read shared notes', 'Read notes in the shared vault.', 0, 'workspace', 'automatic'),
    ('vault.read_private', 'Read own private notes', 'Read the agent''s own private notes.', 0, 'agent', 'automatic'),
    ('web.search', 'Search the web', 'Run a web search and read the result snippets.', 1, 'external', 'automatic'),
    ('tasks.manage', 'Manage tasks', 'Create and update tasks in the workspace.', 1, 'workspace', 'automatic'),
    ('vault.write_own', 'Write own notes', 'Create and edit the agent''s own notes.', 2, 'agent', 'approval'),
    ('vault.write_shared', 'Write shared notes', 'Create and edit notes in the shared vault.', 2, 'workspace', 'approval'),
    ('code.run', 'Run code', 'Run code in the sandbox.', 3, 'sandbox', 'approval'),
    ('web.browse', 'Browse the web', 'Open and interact with web pages.', 3, 'external', 'approval'),
    ('message.send_outbound', 'Send outbound messages', 'Send a message to someone outside the workspace.', 3, 'external', 'approval'),
    ('integration.write', 'Write to integrations', 'Change data in a connected external service.', 3, 'external', 'approval'),
    ('payments.execute', 'Execute payments', 'Spend money or move funds.', 4, 'external', 'approval'),
    ('data.delete_irreversible', 'Delete data permanently', 'Permanently delete data with no way back.', 4, 'workspace', 'approval')
  ) as v (key, name, description, tier, scope, default_mode)
  on conflict (workspace_id, key) do nothing;
$$;
revoke all on function private.seed_workspace_capabilities(uuid) from public, anon, authenticated;

create function private.seed_capabilities_for_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_workspace_capabilities(new.id);
  return new;
end
$$;
revoke all on function private.seed_capabilities_for_new_workspace() from public, anon, authenticated;

create trigger seed_capabilities after insert on public.workspaces
  for each row execute function private.seed_capabilities_for_new_workspace();

-- Backfill workspaces that exist today.
select private.seed_workspace_capabilities(id) from public.workspaces;
