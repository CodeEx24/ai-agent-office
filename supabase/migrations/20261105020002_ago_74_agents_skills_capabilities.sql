-- AGO-74 (2/3): agents, skills, agent_skills, agent_capabilities.
-- RLS enabled, no policies yet (AGO-107). Every parent has unique (workspace_id, id) so children use
-- composite FKs (workspace_id, parent_id): a child can never point at another workspace's row.
-- Rollback: supabase/rollbacks/20261105020002_ago_74_agents_skills_capabilities.down.sql

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  mode text not null default 'strict', -- agent packs always land in strict mode
  status text not null default 'idle',
  archived_at timestamptz, -- retire an agent that has history instead of deleting it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);
create trigger set_updated_at before update on public.agents
  for each row execute function private.set_updated_at();
alter table public.agents enable row level security;

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  body text not null default '', -- Markdown; untrusted data, never instructions to the platform
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);
create trigger set_updated_at before update on public.skills
  for each row execute function private.set_updated_at();
alter table public.skills enable row level security;

create table public.agent_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  skill_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, skill_id),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, skill_id) references public.skills (workspace_id, id) on delete cascade
);
create index agent_skills_workspace_agent_idx on public.agent_skills (workspace_id, agent_id);
create index agent_skills_workspace_skill_idx on public.agent_skills (workspace_id, skill_id);
create trigger set_updated_at before update on public.agent_skills
  for each row execute function private.set_updated_at();
alter table public.agent_skills enable row level security;

-- Capabilities granted to an agent. Granted only by a human member, never by an agent.
create table public.agent_capabilities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null,
  capability text not null check (char_length(capability) between 1 and 200),
  tier smallint not null default 1 check (tier between 0 and 4),
  granted_by uuid, -- the human member who granted it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, capability),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, granted_by) references public.members (workspace_id, id) on delete no action
);
create index agent_capabilities_workspace_agent_idx on public.agent_capabilities (workspace_id, agent_id);
create index agent_capabilities_workspace_granted_by_idx on public.agent_capabilities (workspace_id, granted_by);
create trigger set_updated_at before update on public.agent_capabilities
  for each row execute function private.set_updated_at();
alter table public.agent_capabilities enable row level security;

-- See migration 1: no default table privileges for anon/authenticated (AGO-107 grants what is needed).
revoke all on table public.agents, public.skills, public.agent_skills, public.agent_capabilities
  from anon, authenticated;
