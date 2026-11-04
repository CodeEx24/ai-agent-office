-- AGO-74 (3/3): tasks, runs, run_events, approvals, claims, budgets_usage, notes_index.
-- RLS enabled, no policies yet (AGO-107). run_events append-only enforcement is AGO-102: this schema
-- only allows it (no updated_at, ordering column). Approvals carry hash, expiry and single-use state;
-- no logic yet and no raw payload column (nothing secret is stored).
-- Rollback: supabase/rollbacks/20261105020003_ago_74_work_runs_approvals.down.sql

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  description text not null default '',
  status text not null default 'todo',
  agent_id uuid, -- assignee; kept (set null) if the agent is deleted
  created_by uuid, -- human member
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete set null (agent_id),
  foreign key (workspace_id, created_by) references public.members (workspace_id, id) on delete set null (created_by)
);
create index tasks_workspace_status_idx on public.tasks (workspace_id, status);
create index tasks_workspace_agent_idx on public.tasks (workspace_id, agent_id);
create index tasks_workspace_created_by_idx on public.tasks (workspace_id, created_by);
create trigger set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
alter table public.tasks enable row level security;

-- History is kept: runs/run_events/approvals use NO ACTION toward tasks/agents (deleting an agent or
-- task that has history is refused), while deleting the whole workspace still cascades.
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid,
  agent_id uuid not null,
  status text not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks (workspace_id, id) on delete no action,
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete no action
);
create index runs_workspace_task_idx on public.runs (workspace_id, task_id);
create index runs_workspace_agent_idx on public.runs (workspace_id, agent_id);
create index runs_workspace_status_idx on public.runs (workspace_id, status);
create trigger set_updated_at before update on public.runs
  for each row execute function private.set_updated_at();
alter table public.runs enable row level security;

-- Append-only log (enforced by AGO-102). No updated_at on purpose. `seq` gives a total order.
create table public.run_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null,
  seq bigint generated always as identity,
  type text not null check (char_length(type) between 1 and 100),
  payload jsonb not null default '{}'::jsonb, -- must never contain secrets
  created_at timestamptz not null default now(),
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete no action
);
create index run_events_workspace_run_seq_idx on public.run_events (workspace_id, run_id, seq);
alter table public.run_events enable row level security;

-- Approvals are bound to a payload hash, expire, and are single use. Decided by a human member only.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid,
  agent_id uuid not null,
  action text not null check (char_length(action) between 1 and 200),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending',
  expires_at timestamptz not null,
  consumed_at timestamptz, -- set once on use: single use
  decided_by uuid, -- human member
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete no action,
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete no action,
  foreign key (workspace_id, decided_by) references public.members (workspace_id, id) on delete no action
);
comment on column public.approvals.payload_hash is 'SHA-256 hex of the exact payload that was approved. The payload itself is not stored.';
create index approvals_workspace_status_expires_idx on public.approvals (workspace_id, status, expires_at);
create index approvals_workspace_run_idx on public.approvals (workspace_id, run_id);
create index approvals_workspace_agent_idx on public.approvals (workspace_id, agent_id);
create index approvals_workspace_decided_by_idx on public.approvals (workspace_id, decided_by);
create trigger set_updated_at before update on public.approvals
  for each row execute function private.set_updated_at();
alter table public.approvals enable row level security;

-- An agent's claim on a task. At most one active (unreleased) claim per task.
create table public.claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null,
  agent_id uuid not null,
  run_id uuid,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.tasks (workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete set null (run_id)
);
create unique index claims_one_active_per_task_idx on public.claims (task_id) where released_at is null;
create index claims_workspace_task_idx on public.claims (workspace_id, task_id);
create index claims_workspace_agent_idx on public.claims (workspace_id, agent_id);
create index claims_workspace_run_idx on public.claims (workspace_id, run_id);
create trigger set_updated_at before update on public.claims
  for each row execute function private.set_updated_at();
alter table public.claims enable row level security;

-- Budget and usage per period. agent_id null = workspace-level row.
create table public.budgets_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid,
  period_start date not null,
  period_end date not null,
  token_budget bigint check (token_budget >= 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  cost_budget_cents bigint check (cost_budget_cents >= 0),
  cost_used_cents bigint not null default 0 check (cost_used_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start),
  unique nulls not distinct (workspace_id, agent_id, period_start),
  foreign key (workspace_id, agent_id) references public.agents (workspace_id, id) on delete cascade
);
create trigger set_updated_at before update on public.budgets_usage
  for each row execute function private.set_updated_at();
alter table public.budgets_usage enable row level security;

-- Index of vault notes (the Markdown files stay the source of truth; no note body here).
create table public.notes_index (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 1000),
  title text not null default '',
  content_hash text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  indexed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, path)
);
create trigger set_updated_at before update on public.notes_index
  for each row execute function private.set_updated_at();
alter table public.notes_index enable row level security;

-- See migration 1: no default table privileges for anon/authenticated (AGO-107 grants what is needed;
-- run_events must never get UPDATE, DELETE or TRUNCATE for them: AGO-102).
revoke all on table public.tasks, public.runs, public.run_events, public.approvals, public.claims,
  public.budgets_usage, public.notes_index from anon, authenticated;
