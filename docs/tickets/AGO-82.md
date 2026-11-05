# AGO-82 - US-011 Create workspaces and memberships with roles

## Overview
Epic EP-01 (Data and auth), wave 1, risk tier high (tenancy, authorization, data model). Jira: https://stratyge.atlassian.net/browse/AGO-82. Blocked by AGO-74 (core schema) and AGO-67 (sign-in), both done.

Acceptance criteria (verbatim):
- Given a new user, when onboarding finishes, then a workspace and owner membership exist
- Roles owner, member and viewer are stored and checked in code
- A user cannot read another workspace's rows
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details
**Database** (`supabase/migrations/20261105110001_ago_82_workspace_roles_and_rls.sql`, rollback in `supabase/rollbacks/`):
- `members_role_check`: role is one of `owner`, `member`, `viewer`.
- `members.removed_at`: soft-remove. A removed member keeps their row (audit FKs such as `granted_by` / `decided_by` are NO ACTION) but has no access anywhere.
- `private.role_rank(text)` and **`private.is_member(workspace_id, min_role default 'viewer')`**: the reusable RLS helper. `security definer`, `search_path = ''`, only answers about `auth.uid()`, ignores removed members, unknown role names deny. `authenticated` gets USAGE on `private` and EXECUTE on this one function only.
- RLS policies (authenticated only): `workspaces_select_member`, `workspaces_update_owner` (column grant limited to `name`), `members_select_member` (owners also see removed rows). No INSERT/UPDATE/DELETE policy or grant on `members`: nobody changes a role, including their own, through the API.
- `public.onboard_current_user(p_workspace_name)`: `security definer`, `search_path = ''`, executable by `authenticated` only (revoked from `public` and `anon`). Acts only for `auth.uid()`, creates the workspace and the owner membership in one transaction, and is idempotent (a per-user advisory lock serialises double submits; an existing active membership returns the same workspace).

**Using the helper in another table's policy (AGO-107):**
```sql
create policy agents_read on public.agents for select to authenticated
  using (private.is_member(workspace_id));            -- any active role
create policy agents_write on public.agents for insert to authenticated
  with check (private.is_member(workspace_id, 'member'));  -- member or owner
```
Index `workspace_id` (already true for every table) and grant only the privileges the table needs.

**App**
- `packages/shared/src/workspace/roles.ts`: `WORKSPACE_ROLES`, `workspaceRoleSchema`, `hasMinRole` (same ordering as the SQL).
- `apps/web/src/features/workspaces/workspace-access.ts`: **`requireWorkspaceRole(workspaceId, minRole)`**, the one server-side role gate (verifies the user with the Auth server, reads their own active membership through RLS, denies on any doubt, throws `WorkspaceAccessError`). `getActiveWorkspace(userId)` resolves the workspace for `/app`.
- Onboarding: `/app` shows a name form (`OnboardingForm`, server action `createWorkspaceAction`, Zod-validated) to a signed-in user with no membership; submitting calls the RPC. After that `/app` shows the workspace name and the user's role.
- `createSupabaseServerClient` is now typed with the generated `Database` type.

### Decisions taken (no human at the keyboard; recommended option chosen each time)
| Decision | Chosen | Why |
|---|---|---|
| Role storage | CHECK constraint on the existing `text` column, not a Postgres enum | Reversible and easy to extend; an enum value cannot be removed. |
| Onboarding trigger | Explicit name form on `/app` calling an RPC | "When onboarding finishes" implies a user step; avoids a write on page render. The `Your workspace` heading is kept so AGO-67 specs still pass. |
| Where the create runs | `security definer` RPC, not table INSERT grants | `members` stays without any write grant, so no self-promotion path exists. |
| Soft-remove | Column `removed_at` + honoured by `is_member` and the policies; the removal UI/flow is left to AGO-112 | Resolves the AGO-74 follow-up (hard-deleting a user is blocked by NO ACTION actor FKs) without building member management. |
| Scope of RLS | Policies for `workspaces` and `members` plus the helper; other tables stay deny-by-default | Every-table coverage is AGO-107. |
| Workspace writes | Owner may rename (`update (name)`); nothing else is writable by API roles | Gives the "viewer/member cannot write" rule something real to test without opening more surface. |
| Last owner / many workspaces | Not enforced | Onboarding creates at most one workspace per user; owner transfer and invites are AGO-112. |

## API changes
No HTTP route. New Data API surface: RPC `onboard_current_user(p_workspace_name text) returns uuid` (authenticated only). `workspaces` and `members` are now readable by `authenticated` through RLS. No agent-token path is involved: agents are never members and the RPC needs a user JWT.

## Database changes
One migration plus rollback (above). Regenerated `packages/shared/src/db/database.types.ts` (`pnpm db:types`).
Rollback: apply `supabase/rollbacks/20261105110001_ago_82_workspace_roles_and_rls.down.sql`, delete the `20261105110001` row from `supabase_migrations.schema_migrations`, `pnpm exec supabase migration up` (or `pnpm db:reset` on the previous commit).
Existing AGO-74/AGO-102 pgTAP assertions that assumed `authenticated` had no table access and no executable SECURITY DEFINER function in `private` were narrowed to exactly this ticket's grants (`core_schema`, `core_schema_qa`, `run_events_append_only_qa`). `private.set_updated_at()` had its default PUBLIC EXECUTE revoked (triggers do not need it).

### service_role vs append-only (AGO-102 follow-up)
`workspaces` has no DELETE grant for API roles, and a workspace that has `run_events` cannot be deleted by anyone because `run_events.workspace_id` is ON DELETE RESTRICT. Hard-deleting a workspace is therefore a human-only erasure path (AGO-147). Removing a person is the soft-remove above.

## Dependencies on other tickets
AGO-74 (tables), AGO-67 (sign-in, protected `/app`), AGO-70 (env: no new variable), AGO-102 (FK behaviour). Feeds AGO-107 (apply `private.is_member` to every table), AGO-112 (invites, member management, removal flow, owner transfer).

## Known limitations
- No UI or API to invite, change roles, remove members or transfer ownership (AGO-112). A workspace can have its only owner removed by service_role; nothing in the app does that yet.
- One workspace per user at onboarding; `/app` shows the oldest active membership (no switcher).
- Only `workspaces` and `members` have policies; all other tables remain deny-by-default until AGO-107.
- Live E2E needs the local stack (`E2E_SUPABASE=1`), so it does not run in CI.
- The shared local Auth container currently sends the default email (magic link, no 6-digit code), so the new specs sign in through the magic link (`SignInPage.signInWithMagicLink`). The AGO-67 setup project (`auth.setup.ts`) needs the code template and fails against such a stack until it is restarted with the repo templates.
- Stack-free `auth.spec.ts` "provider state" tests compare the real local stack's provider settings with the app's stub, so they fail when a local stack with providers disabled is running. Unrelated to this ticket; CI is unaffected.

## Testing notes
- pgTAP, inside `node scripts/db-lock.mjs acquire AGO-82` / `release`: `pnpm exec supabase test db` (5 files, all pass). New `supabase/tests/workspace_roles_rls.test.sql` (26 assertions): role CHECK; `is_member` thresholds and unknown role; user A cannot see B's workspace or members (and vice versa); viewer reads but cannot rename; member cannot rename, promote themselves, insert or delete memberships; owner can rename but not change `id`; a soft-removed member sees nothing; anon denied; onboarding creates one owner membership and is idempotent.
- Vitest: `roles.test.ts` (ordering, unknown roles) and `workspace-access.test.ts` (`requireWorkspaceRole`: allowed, below minimum, viewer vs member, no membership, query error, unknown stored role, non-uuid id, signed out).
- Playwright live (`apps/web/e2e/workspaces-live.spec.ts`, 5 tests): sign in then onboarding then `/app` shows the workspace as owner; refresh does not re-onboard; double submit gives one workspace; empty name rejected; a second user never sees the first user's workspace.
  `PORT=$(node scripts/free-port.mjs) E2E_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:44321 NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon key> pnpm --filter @ago/web exec playwright test e2e/workspaces-live.spec.ts --project=chromium --no-deps` (build first).

## Follow-up tasks
- AGO-107: use `private.is_member` for every table; keep `run_events` without UPDATE/DELETE.
- AGO-112: invites, role changes by an owner (human-only route), removal flow that sets `removed_at`, last-owner protection, owner transfer.
- Restart the shared stack so Auth loads `supabase/templates/` again (human, outside this ticket), then re-run `auth.setup.ts`.
