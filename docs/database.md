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
| agents | viewer | owner (AGO-141: the wizard; not `mode`/`status`) | owner (AGO-89: name, role, model, thinking effort, prompt, daily budget, `archived_at`; never `mode`/`status`/`version`) | owner |
| agent_versions | viewer | - (a trigger on `agents` appends; AGO-89) | - (blocked for every role) | - (blocked; only the FK cascade removes) |
| skills | viewer | owner | owner (`name`, `description`, `body`; each new `body` adds a version) | - (AGO-128) |
| skill_versions | viewer | - (a trigger on `skills` appends) | - (blocked for every role) | - (blocked; only the FK cascade removes) |
| agent_skills | viewer | owner | - | owner |
| agent_capabilities | viewer | owner (`granted_by` = caller) | - | owner |
| tasks | viewer | member (`created_by` null or caller) | member | member |
| runs | viewer | member (starts `queued`) | - | - |
| run_events | viewer | - | - | - |
| approvals | viewer | - | member: decide only (pending, unexpired, as themselves) | - |
| claims | viewer (every column except `claim_token`; AGO-160) | - | - | - |
| claim_events | viewer (AGO-160) | - (the claim functions append) | - (blocked for every role) | - (blocked; only the workspace delete cascades) |
| budgets_usage | viewer | owner (budget columns) | owner (budget columns) | - |
| notes_index | viewer | member | member | member |
| policies | viewer | owner (`created_by`/`updated_by` = caller) | owner (`rule`, `archived_at`, `updated_by` only) | - (archive instead) |
| capabilities | viewer | - (seeded by migration and trigger) | owner (`enabled`, `description` only) | - |
| agent_identities | viewer | - (created by a trigger on agents) | - | - |
| agent_credentials | viewer | - (the worker appends; see the AGO-148 section) | - | - |

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

## Skill library with versions (AGO-128)

A skill is Markdown know-how an owner writes and assigns to agents. It is untrusted data and never grants a permission (capabilities do, AGO-125). `skills` stays the *current* row: `body` and `version` always mirror the newest version, so readers that only want "the skill" keep working. `skill_versions` is the immutable history, one row per saved text `(workspace_id, skill_id, version, body, created_by, created_at)`.

- **A new version per changed text.** A `BEFORE UPDATE` trigger sets `version = old.version + 1` whenever `body` changes (and keeps it otherwise); an `AFTER INSERT OR UPDATE` trigger appends the `skill_versions` row, recording the owner's member id. `version` is in no grant, so a client cannot forge it, and saving identical text or editing only the description adds nothing.
- **Versions are immutable for every role**, `service_role` included: UPDATE always raises `42501`; DELETE raises unless the parent skill or workspace is already gone (the FK cascade). API roles only have SELECT.
- **Owners write, everyone reads.** Creating, editing, assigning and removing are owner-only (a change from the member-level AGO-107 policies). Agents are not members and never write skills. Nobody can delete a skill through the API.
- **Assignments follow the latest version.** `agent_skills` has no pin column; pinning an assignment to a version needs an UPDATE grant and policy and is left for the context builder (AGO-145).
- **Size limit.** `skills.body` and `skill_versions.body` are capped at 20,000 characters (`SKILL_BODY_MAX_LENGTH` in `@ago/shared`, which also normalises browser CRLF line breaks to LF before counting).
- **Rollback.** `supabase/rollbacks/20261106150001_ago_128_skill_versions.down.sql`, proven by `scripts/ago-128-rollback.test.mjs` (`RUN_DB_TESTS=1`, inside the db lock). Rolling back drops the history (local data); the current text stays in `skills`.

## Agent identity and credentials (AGO-148)

Each agent has one **identity** (`agent_identities`, a non-login principal created by a trigger on `agents`, never an auth user) and the worker issues it a **credential per run**: a signed token that carries the agent, workspace and run, the capabilities it may use, and an expiry. The `agent_credentials` table is the issuance log.

- **Expiry (AC1).** A credential lives until the task ends or 15 minutes pass, whichever is sooner (`computeCredentialExpiry` in `@ago/shared`). The `agent_credentials_max_ttl_check` constraint refuses anything longer, so it also holds for a buggy caller or `service_role`. A credential is revoked when its run leaves queued or running (trigger on `runs`), and no credential can be issued for a run that has ended.
- **Scope (AC2).** The capability set is the agent's granted capabilities (`agent_capabilities`, enabled in the catalog) intersected with what the caller asked for. A BEFORE INSERT trigger re-checks it: a capability the agent was not granted, that is disabled, or that is not in the catalog cannot be put on a credential. The verifier (`createCredentialVerifier`, worker) also rejects expired, revoked, unknown, wrong-workspace, wrong-agent, wrong-run and missing-capability credentials. A credential never raises a capability's tier: tier 3 and 4 still need a person's approval and every tool call still passes the policy engine (`policyCheckRequired` is always true).
- **Log (AC3).** One row per issuance: `token_hash` (sha256, never the token), `capabilities`, `issued_at`, `expires_at`, `revoked_at`. Append-only for every role, `service_role` and the table owner included; the one allowed change is `revoked_at` null to a timestamp, once. UPDATE, DELETE and TRUNCATE otherwise raise, and the triggers are ENABLE ALWAYS. Members and viewers read their own workspace's rows; nobody writes through the API.
- **Human-only routes.** A request that carries an agent credential (`Authorization: Bearer ago_agt_...`) is refused with 403 by the proxy, the capabilities route and the create-agent server action (`apps/web/src/lib/auth/human-only.ts`), even if it also carries a session cookie. The agent allow-list is empty today.
- **Secret.** `AGENT_CREDENTIAL_SIGNING_SECRET`, see [environments.md](environments.md#agent-credential-signing-secret-ago-148).
- **Rollback.** `supabase/rollbacks/20261107130001_ago_148_agent_identity_credentials.down.sql` (local data only; it drops the issuance log).

## Task claims with expiry (AGO-160)

One agent owns a task at a time and an unrenewed claim expires. Guide: [features/tasks.md](features/tasks.md).

- **`claims` columns added.** `claim_token uuid not null default gen_random_uuid()` (the fence, rotated on every claim), `renewed_at timestamptz`, `release_reason text` (`released`, `completed` or `expired`). `expires_at` is now `NOT NULL` with a default of `now() + 5 minutes` (old rows were backfilled). New checks: `claims_expires_after_claimed`, `claims_release_reason_values`, `claims_release_reason_matches_release`. The partial unique index `claims_one_active_per_task_idx` (one active claim per task) is the atomic backstop.
- **Token privacy.** Members lose the table-level `SELECT` on `claims` and keep a column-level grant that leaves out `claim_token`. `has_table_privilege` is false for `authenticated` now; the role-matrix tests use `has_any_column_privilege`.
- **Functions** (`SECURITY DEFINER`, `search_path = ''`, `EXECUTE` for `service_role` only): `claim_task`, `renew_claim`, `release_claim`, `sweep_expired_claims`. Expiry is judged by `now()` in the database. Refusals return a reason (`agent_archived`, `workspace_mismatch`, `stale_token`, ...), never a silent false.
- **`claim_events`.** Append-only audit table (`workspace_id`, `task_id`, `claim_id`, `agent_id`, `type`, `payload`, `created_at`). UPDATE, DELETE and TRUNCATE are revoked and blocked by a trigger for every role; the only removal is the cascade from a deleted workspace. No foreign keys on `task_id`, `claim_id` and `agent_id`, so the trail outlives them. RLS: members and viewers read their own workspace's rows; nobody writes through the API. The token is never in `payload`.
- **Archived agents.** `claim_task` reads the agent with `FOR SHARE` and refuses an archived one (closes AGO-89 follow-up 2 for the claim path).
- **Rollback.** `supabase/rollbacks/20261114010001_ago_160_task_claims.down.sql` (local data only; it drops `claim_events` and the new columns, and restores the AGO-107 table-level grant). Tests: `supabase/tests/task_claims.test.sql`.
