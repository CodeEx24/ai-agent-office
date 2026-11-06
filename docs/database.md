# Local database: Supabase, migrations and types

Agent Office uses a local Supabase stack in Docker (Postgres 17, Auth, Realtime, Storage, Studio). Hosted Supabase projects are created and linked by a human only; nothing here touches one.

## Ports

This project has its own block so it can run beside other Supabase stacks (which default to 54321-54329). Its `project_id` is `agent-office`.

| Service | Port | URL |
|---|---|---|
| API (Kong) and local MCP | 44321 | `http://127.0.0.1:44321` (`/mcp`) |
| Postgres | 44322 | `postgresql://postgres:postgres@127.0.0.1:44322/postgres` |
| Studio | 44323 | `http://127.0.0.1:44323` |
| Inbucket (test email) | 44324 | `http://127.0.0.1:44324` |
| Analytics | 44327 | |
| Edge runtime inspector | 44328 | |
| Pooler (disabled by default) | 44329 | |
| Shadow DB (`db diff`) | 44320 | |

Ports live in `supabase/config.toml`. Local keys and URLs: `pnpm exec supabase status` (demo keys only). They go in untracked `.env.local` files, never in git.

## Commands

Docker Desktop must be running (about 4 GB of memory).

| Task | Command |
|---|---|
| Start the stack | `pnpm db:start` |
| Stop (keeps data) | `pnpm db:stop` |
| Rebuild the DB from the repo's migrations and seed | `pnpm db:reset` |
| New migration | `pnpm db:migration:new ago_<n>_<what>` |
| Re-apply the seed without a reset | `pnpm db:seed` |
| Regenerate TypeScript types | `pnpm db:types` |

The stack is shared by every worktree. `db:reset` rebuilds it from the current worktree, so wrap resets and DB test runs in the file lock:

```
node scripts/db-lock.mjs acquire AGO-<n>
pnpm db:reset
node scripts/db-lock.mjs release AGO-<n>
```

## Migration workflow

1. `pnpm db:migration:new ago_<n>_<what>` creates `supabase/migrations/<timestamp>_ago_<n>_<what>.sql`.
2. Write the SQL. Every table has `workspace_id` and RLS policies (CLAUDE.md invariants).
3. Write the rollback in `supabase/rollbacks/<same timestamp>_ago_<n>_<what>.down.sql`. Supabase does not run it; it is the reviewed, reversible counterpart.
4. Apply from scratch: lock, `pnpm db:reset`, unlock. The local database now matches the repo.
5. `pnpm db:types` and commit the regenerated `packages/shared/src/db/database.types.ts`.
6. Describe the change and rollback in `docs/tickets/AGO-<n>.md`.

Only one schema-changing ticket is in flight at a time.

## Database tests (pgTAP)

SQL tests live in `supabase/tests/*.sql` and run with `pnpm exec supabase test db` (inside the db lock, like a reset). `core_schema.test.sql` is catalog-driven: every table in `public` must have RLS enabled, a uuid primary key and (except `workspaces`) a `workspace_id uuid not null`, so a new table that breaks the invariants fails the suite.

`run_events_append_only.test.sql` proves `run_events` rejects UPDATE, DELETE and TRUNCATE for `anon`, `authenticated`, `service_role` and the owner, and that `seq` must increase per run. The concurrent-insert check is `scripts/run-events-concurrency.test.mjs` (`RUN_DB_TESTS=1`, inside the db lock). `run_events` is append-only by privileges and triggers (AGO-102): never grant UPDATE/DELETE/TRUNCATE on it, and change its schema through migrations only (a superuser migration is the one way to alter it).

**No cascade into `run_events`.** Its foreign keys to `workspaces` and `runs` are `ON DELETE RESTRICT` (forward migration `20261105100001_ago_102_run_events_restrict_delete.sql`), and the block trigger has no exception. A workspace or run that has events cannot be removed, not even by `service_role` or the owner; every other table still cascades from `workspaces`. Erasing events is a deliberate, human-only path deferred to AGO-147. The integration scripts (`scripts/run-events-*.test.mjs`) clean up with the test-only `scripts/run-events-teardown.mjs`, a single owner transaction that is never used by the app.

## Row-level security: role matrix (AGO-107)

Every table has RLS and per-command policies for `authenticated` built on `private.is_member(workspace_id, min_role)` (AGO-82). `anon` holds no privilege on any table. `service_role` (the runtime) bypasses RLS. Roles: viewer < member < owner. "-" means nobody through the API.

| Table | select | insert | update | delete |
|---|---|---|---|---|
| workspaces | viewer | - | owner (`name` only) | - |
| members | viewer | - | - | - |
| agents | viewer | member | member (not `mode`/`status`) | owner |
| skills | viewer | member | member | member |
| agent_skills | viewer | member | - | member |
| agent_capabilities | viewer | owner (`granted_by` = caller) | - | owner |
| tasks | viewer | member (`created_by` null or caller) | member | member |
| runs | viewer | member (starts `queued`) | - | - |
| run_events | viewer | - | - | - |
| approvals | viewer | - | member: decide only (pending, unexpired, as themselves) | - |
| claims | viewer | - | - | - |
| budgets_usage | viewer | owner (budget columns) | owner (budget columns) | - |
| notes_index | viewer | member | member | member |
| policies | viewer | owner (`created_by`/`updated_by` = caller) | owner (`rule`, `archived_at`, `updated_by` only) | - (archive instead) |
| capabilities | viewer | - (seeded by migration and trigger) | owner (`enabled`, `description` only) | - |

Rules that hold for every table: policies are `to authenticated`, one per command, named `<table>_<command>_<minimum role>`; `workspace_id` and other ids are never in an UPDATE grant (a row cannot move workspaces); approvals keep their `payload_hash`, `expires_at` and `consumed_at` immutable; `run_events` stays append-only; attribution columns (`granted_by`, `decided_by`, `created_by`) must be the caller's own membership (`private.current_member_id`).

**New table checklist:** enable RLS, `revoke all ... from anon, authenticated`, grant only the privileges needed, add one policy per granted command with `private.is_member`, index `workspace_id`, then add the table to `cases` and `expected` in `supabase/tests/rls_every_table.test.sql`. `rls_catalog.test.sql` enumerates every table in `public` and fails the run for a table without RLS or a policy, a privilege without a matching policy, an `anon` privilege, or a policy that is not `to authenticated` / membership-based. `rls_every_table.test.sql` runs select, insert, update and delete on every table as owner, member, viewer, a removed member and a member of another workspace.

## Department hooks and layered policies (AGO-96)

`agents`, `tasks`, `approvals` and `notes_index` (the vault index; there is no `notes` table) each have a nullable `department_id uuid`. It is a hook for departments (EP-15, AGO-108): there is no `departments` table yet, so it has **no foreign key**, it is null on every row, and it is in no INSERT or UPDATE grant for `authenticated` (only `service_role` or a later human-only path sets it). Reads are unchanged. AGO-108 adds the table and the composite FK `(workspace_id, department_id)`, then decides who may assign it. Each column has a partial index `(workspace_id, department_id) where department_id is not null`.

`policies` stores the layered rules: `level` (`baseline`, `department`, `team`, `agent`), `scope_id` (the department, team or agent; null only for baseline, enforced by `policies_scope_matches_level`), `rule` (a JSON object validated by `policyRuleSchema` in `@ago/shared`), `version`, `archived_at`, and the human who wrote it (`created_by`, `updated_by`, composite FKs to `members`). Storage only: evaluation is the policy engine (AGO-34).

- **Owners write, everyone in the workspace reads.** Agents are never members, so they cannot change their own rules. `created_by` and `updated_by` must be the caller's own membership.
- **No hard delete.** Nobody has DELETE; retire a policy with `archived_at`. The row stays as history, and an archived policy can no longer be edited or un-archived through the API (the UPDATE policy requires `archived_at is null`).
- **One active policy per scope.** A unique index on `(workspace_id, level, scope_id) where archived_at is null` (nulls not distinct, so one baseline per workspace) also serves lookups by scope.
- **Immutable columns.** `level`, `scope_id`, `workspace_id`, `version` and `created_*` are not in any UPDATE grant. `version` is bumped by a trigger whenever `rule` changes.
- **Rollback.** `supabase/rollbacks/20261106130001_ago_96_department_hooks_policies.down.sql`, proven by `scripts/ago-96-rollback.test.mjs` (`RUN_DB_TESTS=1`, inside the db lock): roll back, check, re-apply, schema dump unchanged.

## Capability catalog (AGO-125)

`capabilities` is the per-workspace catalog of things an agent can be allowed to do: `key` (lowercase dotted, e.g. `vault.read`), `name`, `description`, `tier` (0 to 4), `scope` (`workspace`, `agent`, `external`, `sandbox`), `default_mode` (`automatic` or `approval`) and `enabled`. It is **not** the same as `agent_capabilities`, which records what a human granted to one agent.

- **Twelve starters in every workspace.** Seeded by `private.seed_workspace_capabilities()`: backfilled for existing workspaces by the migration and run by an AFTER INSERT trigger on `workspaces` for new ones (idempotent, never overwrites an owner's edit). That function is the single place to amend the list; `STARTER_CAPABILITIES` in `@ago/shared` mirrors it and a test fails on drift. The Master List the ticket cites was not found, so this list is the v1 source of truth (see `docs/tickets/AGO-125.md`).
- **Tier 3 and 4 can never be automatic, in data.** `capabilities_high_tier_never_automatic` is a CHECK constraint, so it holds for every role including `service_role` and for any future code path.
- **Tier, scope, default and key change by migration only.** They are in no INSERT or UPDATE grant. Owners may change `enabled` and `description`; members and viewers read; nobody deletes through the API.
- **Read API.** `GET /api/capabilities?workspace_id=<uuid>` (members and viewers; 401 signed out, 403 non-member, 400 bad input). It goes through `listCapabilities` in `apps/web/src/features/capabilities/capability-catalog.ts` (server-only, workspace-scoped, rows validated with `capabilitySchema`). There is no write route.
- **Rollback.** `supabase/rollbacks/20261106140001_ago_125_capability_catalog.down.sql`, proven by `scripts/ago-125-rollback.test.mjs` (`RUN_DB_TESTS=1`, inside the db lock).

## Seed data

`supabase/seed.sql` is loaded by `pnpm db:reset` and re-applied to the running local stack by `pnpm db:seed` (local container only, never a URL). It creates one workspace ("Seed Workspace"), an owner member (`seed-owner@agent-office.local`, no password), 3 agents in Strict mode (Scout, Scribe, Reviewer), 3 starter skills, tier 0 capabilities and 5 tasks. It uses fixed ids and `on conflict do nothing`, so running it again changes nothing. It never seeds `run_events`, `runs`, `approvals` or `claims`. The seed workspace also gets the 12 starter rows of the capability catalog (tiers 0 to 4, tier 3 and 4 default to approval) from the `workspaces` insert trigger (AGO-125); "tier 0 capabilities only" describes the capabilities granted to the seeded agents, not the catalog.

Tests import the ids from `@ago/shared` (`SEED_WORKSPACE_ID`, `SEED_AGENTS`, `SEED_TASKS`, `SEED_COUNTS`, ...) instead of inventing data; a test fails if they drift from `seed.sql`. When you add a table that deserves starter rows, add them to `seed.sql` with a fixed id and the matching constant.

## Rollback

Local database: run `pnpm db:reset` on the previous commit, which rebuilds it from that commit's migrations. This is the normal path.

Undoing one migration on a running local database: apply its `rollbacks/*.down.sql` (for example `docker exec -i supabase_db_agent-office psql -U postgres < supabase/rollbacks/<file>.down.sql`), then delete the row from `supabase_migrations.schema_migrations`, or simply reset. To drop a migration from a branch, revert the commit that added both the migration and its rollback file.

Hosted environments are migrated by a human through the release process, not by agents.

## Generated types

`pnpm db:types` writes `packages/shared/src/db/database.types.ts` from the local database (`public` schema) and `@ago/shared` re-exports `Database` and `Json`. The script writes only when generation succeeds. Never edit the file by hand.
