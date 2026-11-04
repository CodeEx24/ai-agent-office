-- AGO-74 (1/3): tenancy foundation: updated_at trigger function, workspaces, members.
-- Scope: role semantics = AGO-82, RLS policies = AGO-107. RLS is enabled here with no policies
-- (deny-by-default for anon/authenticated); service_role bypasses RLS.
-- Rollback: supabase/rollbacks/20261105020001_ago_74_tenancy_foundation.down.sql

-- Shared trigger function. Lives in `private` (no API access). Triggers do not need the caller to
-- have USAGE on the function's schema (EXECUTE is checked when the trigger is created), so no
-- grants on `private` are required or given.
create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.set_updated_at() is 'BEFORE UPDATE trigger: stamps updated_at. No grants needed.';

-- workspaces: the tenant root. Its id is the workspace_id of every other table.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.workspaces is 'Tenant root. workspaces.id is the workspace_id on every other table.';
create trigger set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();
alter table public.workspaces enable row level security;

-- members: a human user's membership in a workspace. Agents are never members.
create table public.members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member', -- allowed values and checks: AGO-82
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id)
);
comment on column public.members.role is 'Role name. Allowed values and enforcement arrive with AGO-82.';
create index members_user_id_idx on public.members (user_id);
create trigger set_updated_at before update on public.members
  for each row execute function private.set_updated_at();
alter table public.members enable row level security;

-- Defence in depth: Supabase grants every privilege on new public tables to anon/authenticated and
-- RLS does not cover TRUNCATE. Revoke them now; AGO-107 grants back exactly what each table needs.
revoke all on table public.workspaces, public.members from anon, authenticated;
