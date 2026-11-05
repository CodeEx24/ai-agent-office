-- AGO-82: workspace roles, membership-based RLS for workspaces and members, and the onboarding RPC.
-- Scope: every-table RLS is AGO-107; invites and member management UI are AGO-112.
-- Rollback: supabase/rollbacks/20261105110001_ago_82_workspace_roles_and_rls.down.sql

-- 1. Roles: a closed set, enforced by the database. Role changes are never granted to API roles
--    (human-in-the-loop: nobody promotes themselves), only service_role / future human-only paths.
alter table public.members
  add constraint members_role_check check (role in ('owner', 'member', 'viewer'));
comment on column public.members.role is 'owner > member > viewer. Checked in code by requireWorkspaceRole and in RLS by private.is_member.';

-- 2. Soft-remove: a removed member keeps their row (actor FKs such as granted_by/decided_by are
--    NO ACTION and the audit trail must survive) but loses all access. The removal flow is AGO-112.
alter table public.members add column removed_at timestamptz;
comment on column public.members.removed_at is 'Soft-remove marker. Non-null = no access. The row is kept for the audit trail.';

-- 3. Policy helpers live in `private` (not exposed by the Data API).
create function private.role_rank(p_role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_role when 'viewer' then 1 when 'member' then 2 when 'owner' then 3 end
$$;
comment on function private.role_rank(text) is 'viewer=1, member=2, owner=3, anything else null (denied).';

-- Reusable by every table policy (AGO-107):
--   using (private.is_member(workspace_id))             -- any active role may read
--   using (private.is_member(workspace_id, 'member'))   -- member or owner may write
--   using (private.is_member(workspace_id, 'owner'))    -- owner only
-- SECURITY DEFINER so it can read `members` without recursing into the members policy.
-- It only ever answers about auth.uid(), so it cannot be used to probe other users.
create function private.is_member(p_workspace_id uuid, p_min_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.role_rank(p_min_role) is not null
    and exists (
      select 1
      from public.members m
      where m.workspace_id = p_workspace_id
        and m.user_id = (select auth.uid())
        and m.removed_at is null
        and private.role_rank(m.role) >= private.role_rank(p_min_role)
    ),
    false
  )
$$;
comment on function private.is_member(uuid, text) is 'True when auth.uid() is an active member of the workspace with at least p_min_role. Unknown role names deny.';

-- Policies run with the caller's privileges, so authenticated needs USAGE on `private` plus
-- EXECUTE on this one function. Nothing else in `private` is callable by them.
revoke all on function private.role_rank(text) from public, anon, authenticated;
revoke all on function private.is_member(uuid, text) from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid, text) to authenticated;

-- 4. Grants and policies for workspaces and members (RLS was enabled in AGO-74).
grant select on public.workspaces, public.members to authenticated;
grant update (name) on public.workspaces to authenticated; -- renaming; owner-only by policy

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (private.is_member(id));

create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (private.is_member(id, 'owner'))
  with check (private.is_member(id, 'owner'));

-- Members see their workspace's active members; owners also see removed ones.
-- No insert/update/delete policy or grant: memberships change only through the RPC below,
-- service_role, or AGO-112's human-only flows.
create policy members_select_member on public.members
  for select to authenticated
  using (
    private.is_member(workspace_id)
    and (removed_at is null or private.is_member(workspace_id, 'owner'))
  );

-- 5. Onboarding: create a workspace and the owner membership atomically, only for auth.uid().
--    Idempotent: a user who already has an active membership gets that workspace back (refresh,
--    double submit). The advisory lock serialises concurrent calls for the same user.
create function public.onboard_current_user(p_workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_name text := btrim(p_workspace_name);
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 120 then
    raise exception 'workspace name must be 1 to 120 characters' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ago82:onboard:' || v_user_id::text, 0));

  select m.workspace_id into v_workspace_id
  from public.members m
  where m.user_id = v_user_id and m.removed_at is null
  order by m.created_at, m.id
  limit 1;
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  insert into public.workspaces (name) values (v_name) returning id into v_workspace_id;
  insert into public.members (workspace_id, user_id, role) values (v_workspace_id, v_user_id, 'owner');
  return v_workspace_id;
end;
$$;
comment on function public.onboard_current_user(text) is 'Creates a workspace plus the caller''s owner membership, once. Returns the workspace id. authenticated only.';

revoke all on function public.onboard_current_user(text) from public, anon;
grant execute on function public.onboard_current_user(text) to authenticated;
