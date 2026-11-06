# AGO-96 - US-013 Add department hooks and layered policy table

## Overview
Epic EP-15 (Departments), wave 1, workstream WS-E (Security and Governance), risk tier **high** (data model, authorization, human-in-the-loop surface). Jira: https://stratyge.atlassian.net/browse/AGO-96. Blocked by AGO-74 (core schema) and AGO-107 (RLS on every table), both done. Builds on AGO-82 (`private.is_member`, roles) and AGO-122 (seed data, untouched). Unblocks AGO-108 (departments and teams) and AGO-34 (policy engine).

Acceptance criteria (verbatim):
- Columns and the policies table exist with an RLS policy
- Existing flows work unchanged with department_id null
- A migration test proves rollback
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

The ticket text says "agents, tasks, notes and approvals". There is no `notes` table: the vault index is `notes_index`, so that is where the column went.

## Implementation details
One migration, `supabase/migrations/20261106130001_ago_96_department_hooks_policies.sql`, with its rollback in `supabase/rollbacks/`.

**Department hooks.** `department_id uuid` (nullable) on `agents`, `tasks`, `approvals` and `notes_index`, each with a partial index `(workspace_id, department_id) where department_id is not null`. No foreign key (see decisions). The column is in **no** INSERT or UPDATE grant for `authenticated`, so the API cannot set it yet; reads work through the existing table-level SELECT grant. The AGO-107 role matrix for those four tables is therefore unchanged.

**`public.policies`.** `id`, `workspace_id` (cascade), `level` (`baseline | department | team | agent`), `scope_id` (nullable), `rule jsonb` (must be an object), `version`, `archived_at`, `created_by`, `updated_by` (composite FKs to `members`), timestamps.
- `policies_scope_matches_level` check: baseline has no scope, every other level has one.
- Unique index on `(workspace_id, level, scope_id) nulls not distinct where archived_at is null`: one active policy per scope, one baseline per workspace, and it serves lookups by `(workspace_id, level, scope)`. Plus indexes on the two member FKs.
- `private.bump_policy_version()` trigger: `version` moves forward by one whenever `rule` changes, whatever the caller sends. Execute is revoked from everyone (a trigger function does not need it; the AGO-107 catalog test would otherwise fail).
- RLS, per command, following the AGO-107 pattern (`to authenticated`, name `<table>_<command>_<min role>`, `private.is_member`): `policies_select_viewer`, `policies_insert_owner`, `policies_update_owner`. INSERT and UPDATE pin `created_by` / `updated_by` to the caller with `private.current_member_id`. No DELETE grant or policy: archive instead.
- Grants: SELECT; INSERT `(workspace_id, level, scope_id, rule, created_by, updated_by)`; UPDATE `(rule, archived_at, updated_by)`. `level`, `scope_id`, `workspace_id`, `version`, `created_*` can never change through the API.

**Types.** `packages/shared/src/policy/policy-schemas.ts`: `POLICY_LEVELS`, `policyLevelSchema`, `policyRuleSchema` (strict `{ version: 1, rules: [{ action, effect, note? }] }`, `effect` is `allow | require_approval | deny`, max 200 rules) and `createPolicySchema` (level and scope must agree, same rule as the database check). `pnpm db:types` regenerated `database.types.ts` (idempotent). No evaluation logic: that is AGO-34.

**Tests.** `supabase/tests/department_hooks_policies.test.sql` (54 assertions), `scripts/ago-96-rollback.test.mjs`, `packages/shared/src/policy/policy-schemas.test.ts`. Existing suites that hard-coded "13 tables" or exact grant lists were updated (see Testing notes). Docs: `docs/database.md` (role matrix row and a new section).

### Decisions taken (no human at the keyboard; recommended option chosen each time)
| Decision | Chosen | Why |
|---|---|---|
| "notes" table | Use `notes_index` | No `notes` table exists; `notes_index` is the vault index and the note-shaped table AGO-74 created. |
| FK on `department_id` | None for now | The `departments` table is AGO-108 (EP-15). A FK to a minimal stub would force a shape on that ticket. AGO-108 adds the table and the composite FK `(workspace_id, department_id)`. |
| Who can set `department_id` | Nobody through the API yet (not in any grant); `service_role` only | A department assignment changes which policies apply to an agent or task, so it is governance. With no departments table there is nothing to assign; AGO-108 decides the role and path. Keeps AC2 trivially true. |
| `policies.level` | text + check constraint, not a Postgres enum | Matches the repo (`status`, `role`, `mode` are text + check); easier to migrate. The Zod enum mirrors it. |
| `scope_id` | Polymorphic uuid, no FK, checked against `level` | Points at a department, team or agent; teams and departments do not exist yet. A dangling id is harmless: the engine resolves scope inside the workspace. |
| Who writes policies | Owners only; agents and members never | Human in the loop: agents cannot change their own rules. Matches the owner = governance column of the AGO-107 matrix. |
| Delete | No DELETE for anyone; `archived_at` retires a policy | Audit-friendly: history of what governed an agent is kept. Matches `runs` (never deleted through the API). A hard delete can be added later as an owner-only path if needed. |
| Uniqueness | One active policy per `(workspace, level, scope)`; baseline unique via `nulls not distinct`; archived rows excluded | Layering needs a single answer per layer. Archived rows keep history without blocking a replacement. |
| Versioning | `version` bumped by trigger on every `rule` change, not writable | Cheap change counter for the engine and audit. Not a history table: row-level history can follow with the audit work. |
| Attribution | `created_by` / `updated_by` not null, pinned to the caller via `private.current_member_id` | Same pattern as `granted_by` and `decided_by` in AGO-107. |
| Rule payload shape | `{ version: 1, rules: [{ action, effect, note? }] }`, strict | The ticket needs a validated payload but not evaluation. This is the minimum that can express allow / require approval / deny, and `version` lets AGO-34 evolve it. AGO-34 may extend it. |
| Rollback proof | Script test that applies the down file, then the up file, and compares `pg_dump -s` | Same proof AGO-74 ran by hand, now automated (`RUN_DB_TESTS=1`, inside the db lock). |
| Migration name | `ago_96` | The brief's constraint 1 says `ago_82`, which contradicts CLAUDE.md section 5 and the coordinator notes (`<ts>_ago_96_<what>.sql`); the ticket key wins. Same call AGO-107 made. |

## API changes
No HTTP route. Data API: `authenticated` gets SELECT on `policies` (membership RLS), INSERT/UPDATE for owners on the columns above, nothing else. `anon` has nothing. `@ago/shared` exports the policy schemas.

## Database changes
One migration plus rollback; `pnpm db:types` regenerated (new `policies` table and four `department_id` columns).
Rollback: apply `supabase/rollbacks/20261106130001_ago_96_department_hooks_policies.down.sql` (drops the 3 policies, the table, the trigger function, the 4 indexes and the 4 columns; no `cascade`), then delete the `20261106130001` row from `supabase_migrations.schema_migrations`, or `pnpm db:reset` on the previous commit. The rollback deletes `policies` rows and the `department_id` values: local data only.
Rollback proof (inside the db lock, `scripts/ago-96-rollback.test.mjs`): migration applied, schema dumped; down file applied, hooks and table gone and 3 policies fewer; migration re-applied, schema dump identical (empty diff). `supabase db diff` reports "No schema changes found" and `supabase db lint` reports no schema errors.

## Dependencies on other tickets
AGO-74 (tables), AGO-82 (`private.is_member`, roles), AGO-107 (grant and policy pattern, catalog test, `private.current_member_id`), AGO-122 (seed untouched; `pnpm db:seed` re-run, idempotent). Feeds AGO-108 (departments and teams: adds the FK and decides who assigns a department) and AGO-34 (policy engine: evaluates these rows).

## Known limitations
- `department_id` has no FK and cannot be set through the API until AGO-108.
- No evaluation logic: nothing reads `policies` yet. Layer precedence (baseline < department < team < agent) is the engine's job.
- The Zod rule shape is the minimum for storage; the database only checks it is a JSON object, so a direct SQL writer is not forced through `policyRuleSchema`. Writers go through the shared schema (API, CLI, UI), as with agent packs.
- `scope_id` is not checked against a real department, team or agent; it is scoped by workspace only through the engine's lookups.
- No policy history table: `version` counts changes, and archiving keeps retired rows, but old rule payloads are overwritten on update.
- No hard delete for policies; a workspace delete still cascades them.
- Live e2e needs the local stack (`E2E_SUPABASE=1`), so it does not run in CI.

## Testing notes
- DB: `node scripts/db-lock.mjs acquire AGO-96`, `pnpm db:reset`, `pnpm exec supabase test db` (12 files, 390 assertions, all pass), `pnpm exec supabase db lint`, `pnpm exec supabase db diff`, `node scripts/db-lock.mjs release AGO-96`.
- New: `department_hooks_policies.test.sql` (hooks are nullable uuid with no FK and null on existing rows; policy constraints; one active per scope; archive frees the slot; version trigger; owner-only writes, pinned attribution, immutable columns, no delete; member, viewer, removed owner and outsider; anon; existing flows for agents, tasks, notes and approvals with a null department; `department_id` not writable).
- Updated for the 14th table: `rls_every_table` (policies in fixtures, matrix and cases: 56 cases, 280 attempts), `rls_catalog` (37 policies), `rls_every_table_qa` (exact INSERT and UPDATE columns, 14 tables), `core_schema_qa` (14 tables, 18 parent FKs, 28 anon denials).
- Rollback: `RUN_DB_TESTS=1 pnpm exec vitest run --config vitest.scripts.config.mjs scripts/ago-96-rollback.test.mjs` (inside the lock).
- Script suites with `RUN_DB_TESTS=1 --no-file-parallelism`: 103 pass (seed, run_events, AGO-70 acceptance, rollback). `pnpm db:seed` re-run: idempotent.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass. `pnpm test:e2e` with `E2E_SUPABASE=1` and the local anon key: 193 pass; one AGO-67 sign-in redirect spec (`auth-live.spec.ts:50`) failed once under full-suite load and passed on its own re-run (8/8), so it looks like a timing flake unrelated to this ticket. The AGO-107 live RLS specs (`rls-every-table-live`) pass. Without `E2E_SUPABASE`, 66 pass and the live specs skip.
- Cascade check (rolled-back transaction): deleting a workspace removes its policies even though `policies` has no-action FKs to `members`.
- Independent subagent review was not run: the dispatch brief forbids subagents. The self-review stands in; `/pr-gate` is the independent gate.

## Follow-up tasks
- AGO-108: create `departments` (and teams), add the composite FK on the four `department_id` columns and on `policies.scope_id` where it fits, and decide who may assign a department.
- AGO-34: policy engine reads `policies`, resolves layers, and extends `policyRuleSchema` if it needs more than `action` / `effect`.
- Decide whether policies need a history table or an audit event when edited (today `version` and `archived_at` only).
- Optional owner-only hard-delete path for policies, if a real need appears.
