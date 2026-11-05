# AGO-74 - US-009 Create the core schema migrations

## Overview
The 13 core tables of Agent Office as Supabase migrations: workspaces, members, agents, skills, agent_skills, agent_capabilities, tasks, runs, run_events, approvals, claims, budgets_usage, notes_index. Jira: AGO-74, epic EP-01 (Data and auth), wave 1. Risk: high (data model, tenancy, approvals). Local Supabase only; nothing touches a hosted project.

Out of scope on purpose (each owned by another ticket): role semantics on `members` (AGO-82), RLS **policies** (AGO-107), `run_events` append-only enforcement (AGO-102), departments and the policies table (AGO-96), seed data (AGO-122).

## Implementation details
Three migrations, each with a hand-run rollback in `supabase/rollbacks/`:

| Migration | Contents |
|---|---|
| `20261105020001_ago_74_tenancy_foundation` | `private.set_updated_at()`, `workspaces`, `members` |
| `20261105020002_ago_74_agents_skills_capabilities` | `agents`, `skills`, `agent_skills`, `agent_capabilities` |
| `20261105020003_ago_74_work_runs_approvals` | `tasks`, `runs`, `run_events`, `approvals`, `claims`, `budgets_usage`, `notes_index` |

Conventions applied to every table:
- uuid PK `id` (`gen_random_uuid()`), including join table `agent_skills` (unique `(agent_id, skill_id)`) and `run_events`.
- `created_at` / `updated_at` `timestamptz not null default now()`, with a `BEFORE UPDATE` trigger (`private.set_updated_at`, security invoker, `search_path = ''`). `run_events` has no `updated_at` (append-only ready) and has `seq bigint generated always as identity` for total ordering.
- `workspace_id uuid not null` on every table except `workspaces` (whose `id` is the tenant), indexed (leading column of a composite index or unique constraint).
- Tenancy: each parent has `unique (workspace_id, id)` and children reference `(workspace_id, parent_id)`, so a child can never point at another workspace's row.
- RLS enabled on all 13 tables in the same migration that creates them, **no policies** (deny-by-default). Table privileges are also revoked from `anon` and `authenticated` (see decisions); AGO-107 adds policies and grants.
- Approvals: `payload_hash` (CHECK 64 lowercase hex), `expires_at not null`, `consumed_at` (single use), `decided_by` -> `members`. No raw payload column; no secret is stored in any column.
- `private` schema: only `private.set_updated_at()` is added. Trigger functions are checked for EXECUTE when the trigger is created, not when it fires, so **no grants on `private` are needed or given**. Verified by the pgTAP test updating a row as `service_role` (no USAGE on `private`).

### Foreign keys and `on delete`
| FK | On delete | Why |
|---|---|---|
| every `workspace_id` -> `workspaces.id` | cascade (except `run_events`: restrict) | a workspace's data goes with it; **since AGO-102 `run_events.workspace_id` is `ON DELETE RESTRICT`**, so a workspace that has events cannot be removed (erasure is a human-only path, AGO-147) |
| `members.user_id` -> `auth.users` | cascade | membership dies with the account |
| `agent_skills` -> `agents`, `skills` | cascade | a link row is meaningless without either side |
| `agent_capabilities.agent_id` -> `agents` | cascade | capabilities belong to the agent |
| `agent_capabilities.granted_by` -> `members` | no action | keep who granted a capability (audit); see follow-ups |
| `tasks.agent_id`, `tasks.created_by` | set null (column only) | task survives losing its assignee/creator; column-list form so `workspace_id` is never nulled |
| `runs.task_id`, `runs.agent_id` | no action | run history is kept; an agent/task with runs cannot be deleted (tested). Retire with `agents.archived_at` |
| `run_events.run_id` -> `runs` | no action (restrict since AGO-102) | the log is never silently dropped |
| `approvals.run_id`, `agent_id`, `decided_by` | no action | approval history and the human decision are kept |
| `claims.task_id`, `agent_id` | cascade | a claim is transient |
| `claims.run_id` | set null (column only) | the claim outlives a run reference |
| `budgets_usage.agent_id` | cascade | usage rows belong to the agent (null agent = workspace-level row) |

## API changes
None.

## Database changes
Migrations and rollbacks above. Regenerated `packages/shared/src/db/database.types.ts` (`pnpm db:types`, idempotent: a second run leaves no diff).
Rollback: apply the `.down.sql` files newest first, delete the three `20261105020001..3` rows from `supabase_migrations.schema_migrations`, then `pnpm exec supabase migration up`; or `pnpm db:reset` on the previous commit. Each down drops objects explicitly (no `cascade`); the first also drops `private.set_updated_at()`, so the AGO-78 baseline rollback (`drop schema private`) still works.

### Decisions taken (recommended option chosen, no human available)
- **Join table and run_events use a uuid PK** (not composite PK) because the coordinator note says "PKs (uuid)"; uniqueness is kept with `unique (agent_id, skill_id)`.
- **Composite tenancy FKs** with `unique (workspace_id, id)` on parents, over single-column FKs: the database itself rejects cross-workspace links.
- **`members.role` is a plain `text not null default 'member'` with no CHECK.** AGO-82 owns the allowed values (owner/member/viewer) and enforcement. The default is the least-privileged non-viewer value and carries no semantics yet.
- **No `department_id`** anywhere: AGO-96 adds it.
- **Revoke all table privileges from `anon` and `authenticated`** on every table (independent DB review finding). RLS does not cover TRUNCATE and Supabase grants everything to these roles by default, so the first policy AGO-107 adds would otherwise widen exposure. `service_role` is untouched. AGO-107 grants per table what it needs; `run_events` must never get UPDATE/DELETE/TRUNCATE for them (tested).
- **`agents.archived_at`** added (review finding): agents with run history cannot be deleted, so there must be a retire path without a second schema ticket.
- **Actor FKs to `members` stay `no action`** (`granted_by`, `decided_by`) to keep the audit trail; the cost is that a user with grants/decisions cannot be hard-deleted. Handled in AGO-82 (soft-remove members). `tasks.created_by` is `set null` because it is not an audit field.
- **State columns are free text without CHECKs** (`agents.mode/status`, `tasks.status`, `runs.status`, `approvals.status`): their allowed values belong to the tickets that implement the behaviour. `agents.mode` defaults to `strict` (agent packs land in strict mode).
- **Removed the redundant `budgets_usage (workspace_id, agent_id)` index**; the unique constraint covers that prefix.
- **pgTAP, not Vitest**, for DB tests (`supabase test db`): no test runner exists yet (AGO-111). The core checks are catalog-driven so they also guard later tables.

## Dependencies on other tickets
Blocked by AGO-78 (local Supabase, done). Blocks AGO-82, AGO-96, AGO-102, AGO-107, AGO-122, AGO-125, AGO-128, AGO-148, AGO-151, AGO-121.

## Known limitations
- No RLS policies and no grants for API roles: nothing is readable through the Data API until AGO-107 (intended).
- `pnpm lint` and `pnpm test` scripts do not exist yet (AGO-111) and there is no CI (AGO-92): skipped. `pnpm typecheck` and `pnpm build` pass; DB checks are pgTAP.
- Not enforced in the schema (left to the owning tickets): approval state coupling (approved requires `decided_by`, `consumed_at` requires approved, status allow-list), same-workspace parent agreement (a claim's run belonging to the same task/agent), overlapping `budgets_usage` periods, stale claims (`expires_at` does not release the unique active-claim index), `agent_capabilities.tier` 3-4 grants (packs must ignore them in import code).
- Human-only vs runtime-written columns share a row (`budgets_usage` budget vs used, `agents.mode` vs `status`): AGO-107/AGO-82 must use column grants or guard triggers.
- `run_events` has no actor column.
- Advisors: only INFO notices (`rls_enabled_no_policy` x13, expected; `unused_index` on a fresh DB). No unindexed FK, no mutable `search_path`.

## Testing notes
All run locally inside `node scripts/db-lock.mjs acquire AGO-74` ... `release AGO-74`:
- `pnpm db:reset` applies baseline + 3 migrations from scratch.
- `pnpm exec supabase test db`: `supabase/tests/core_schema.test.sql`, 35 assertions, PASS (twice: fresh and after rollback/re-apply). Covers: 13 tables exist; RLS on every public table; uuid PK on every table; `workspace_id uuid not null` + a FK on it for every table but `workspaces`; timestamps; `run_events` has `seq` and no `updated_at`; approvals hash/expiry/single-use columns and no payload column; `updated_at` moves on update as `service_role`; no TRUNCATE and no table privileges for `anon`/`authenticated`; cross-workspace child inserts fail (23503); bad hash fails (23514); second active claim fails (23505); agent with runs cannot be deleted; deleting a workspace leaves 0 rows in all 12 child tables while another workspace is untouched.
- Rollback proof: with the 3 down files applied newest first, `public` has 0 tables and 0 `set_updated_at` functions while `private` still exists; after deleting the 3 `schema_migrations` rows and `supabase migration up`, 13 tables are back; `supabase db diff` reports "No schema changes found"; pgTAP passes again. Rolling back only migration 3 and re-applying also works.
- `pnpm db:types` twice -> identical file; `pnpm typecheck` and `pnpm build` pass (5/5 tasks).
- Local MCP `get_advisors` security + performance: INFO only (see above).
- Independent review (high risk): `ecc:database-reviewer` and `ago-invariants-reviewer`. No blocking findings. Fixed: table privileges, `archived_at`, redundant index, deny tests. Recorded as follow-ups: the rest of the limitations above.

## Follow-up tasks
- AGO-107: policies plus per-table grants; never grant UPDATE/DELETE/TRUNCATE on `run_events`; separate human-only vs runtime-written columns.
- AGO-102 (done): append-only wins over the workspace cascade; `run_events` FKs became RESTRICT in a forward migration and the erasure path is deferred to AGO-147. Still open: an actor column decision.
- AGO-82: role CHECK/enum; soft-remove members (the `no action` actor FKs block hard user deletion).
- Approvals ticket: status allow-list and coupling CHECKs, `expires_at > created_at`; render the payload for the human from another source (hash only is stored).
- CHECKs for `agents.mode/status`, `tasks.status`, `runs.status` with their feature tickets.
