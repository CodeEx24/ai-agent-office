-- AGO-128: the skill library with versions (EP-03). Builds on AGO-74 (skills, agent_skills), AGO-82
-- (private.is_member), AGO-107 (per-command RLS and exact grants) and AGO-96 (the version-bump trigger pattern).
-- Rollback: supabase/rollbacks/20261106150001_ago_128_skill_versions.down.sql
--
-- Decisions (full list in docs/tickets/AGO-128.md):
-- * public.skills stays the "current" row: skills.body / skills.version always mirror the newest version, so
--   existing readers (seed, tests, the future context builder) keep working.
-- * public.skill_versions is the immutable history. A new row is appended by a trigger whenever skills.body
--   changes (and once on insert), so no code path can edit a skill without leaving a version behind.
-- * Humans decide: only owners create or edit skills and assign or remove them. Members and viewers read.
--   An agent never writes a skill. Nobody can delete a skill through the API (no delete grant).
-- * Versions are immutable for every role, service_role included: UPDATE and TRUNCATE always raise (and the
--   privileges are revoked); DELETE raises unless the parent skill or workspace is already gone (the FK cascade).
-- * An assignment follows the latest version (no pin column). Pinning is a follow-up (needs an UPDATE grant).

-- Skill text is Markdown and untrusted data. One cap, mirrored by SKILL_BODY_MAX_LENGTH in packages/shared.
alter table public.skills
  add constraint skills_body_length_check check (char_length(body) <= 20000);

create table public.skill_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  skill_id uuid not null,
  version integer not null check (version >= 1),
  body text not null default '' check (char_length(body) <= 20000),
  created_by uuid, -- the human member who saved it; null for seed, backfill and service-role writes
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, skill_id, version),
  foreign key (workspace_id, skill_id) references public.skills (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references public.members (workspace_id, id) on delete no action
);
create index skill_versions_workspace_created_by_idx on public.skill_versions (workspace_id, created_by);
comment on table public.skill_versions is 'Immutable history of a skill''s Markdown text (AGO-128). Appended by a trigger on skills; UPDATE and DELETE are blocked for every role.';

-- Backfill: every existing skill gets its current text as a version row.
insert into public.skill_versions (workspace_id, skill_id, version, body)
select workspace_id, id, version, body from public.skills;

-- 1. The version moves forward by one on every body change, whatever the caller sends (version is also in no
--    grant). Runs as the invoker: it only edits NEW.
create function private.bump_skill_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end
$$;
revoke all on function private.bump_skill_version() from public, anon, authenticated;
create trigger bump_skill_version before update on public.skills
  for each row execute function private.bump_skill_version();

-- 2. Append the version row. SECURITY DEFINER because authenticated has no INSERT on skill_versions.
create function private.append_skill_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.skill_versions (workspace_id, skill_id, version, body, created_by)
    values (new.workspace_id, new.id, new.version, new.body, private.current_member_id(new.workspace_id));
  end if;
  return null;
end
$$;
revoke all on function private.append_skill_version() from public, anon, authenticated;
create trigger append_skill_version after insert or update on public.skills
  for each row execute function private.append_skill_version();

-- 3. Immutability, for every role.
create function private.skill_versions_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.skills s where s.id = old.skill_id)
          or not exists (select 1 from public.workspaces w where w.id = old.workspace_id)) then
    return old; -- the parent is already gone: this is the FK cascade
  end if;
  raise exception 'skill_versions is append-only: % is not allowed', tg_op
    using errcode = '42501', hint = 'Save the skill again to create a new version.';
end
$$;
revoke all on function private.skill_versions_block_change() from public, anon, authenticated;
create trigger skill_versions_block_update before update on public.skill_versions
  for each row execute function private.skill_versions_block_change();
create trigger skill_versions_block_delete before delete on public.skill_versions
  for each row execute function private.skill_versions_block_change();
-- TRUNCATE skips row triggers and RLS, so it needs its own statement trigger (same pattern as AGO-102 run_events).
-- The function raises for it: only a row-level DELETE with a vanished parent is let through.
create trigger skill_versions_block_truncate before truncate on public.skill_versions
  for each statement execute function private.skill_versions_block_change();
-- ENABLE ALWAYS: also fire under session_replication_role = replica.
alter table public.skill_versions enable always trigger skill_versions_block_update;
alter table public.skill_versions enable always trigger skill_versions_block_delete;
alter table public.skill_versions enable always trigger skill_versions_block_truncate;

-- 4. RLS and grants. skill_versions: read only. skills and agent_skills: owner writes.
alter table public.skill_versions enable row level security;
revoke all on table public.skill_versions from anon, authenticated;
grant select on public.skill_versions to authenticated;
-- service_role bypasses RLS and gets default grants: take away everything that modifies or empties the table.
revoke update, delete, truncate, trigger, references on table public.skill_versions from public, anon, authenticated, service_role;
revoke update (id, workspace_id, skill_id, version, body, created_by, created_at) on public.skill_versions from public, anon, authenticated, service_role;
create policy skill_versions_select_viewer on public.skill_versions for select to authenticated
  using (private.is_member(workspace_id));

revoke delete on public.skills from authenticated;
drop policy skills_delete_member on public.skills;
drop policy skills_update_member on public.skills;
drop policy skills_insert_member on public.skills;
create policy skills_insert_owner on public.skills for insert to authenticated
  with check (private.is_member(workspace_id, 'owner'));
create policy skills_update_owner on public.skills for update to authenticated
  using (private.is_member(workspace_id, 'owner'))
  with check (private.is_member(workspace_id, 'owner'));

drop policy agent_skills_delete_member on public.agent_skills;
drop policy agent_skills_insert_member on public.agent_skills;
create policy agent_skills_insert_owner on public.agent_skills for insert to authenticated
  with check (private.is_member(workspace_id, 'owner'));
create policy agent_skills_delete_owner on public.agent_skills for delete to authenticated
  using (private.is_member(workspace_id, 'owner'));
