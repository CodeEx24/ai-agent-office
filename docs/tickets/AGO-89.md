# AGO-89 - US-048 Edit, duplicate and archive agents

- Ticket: https://stratyge.atlassian.net/browse/AGO-89 (Story, Epic EP-03, wave 2, WS-C, sprint 10)
- PRs: (pending)
- Blocked by: AGO-141 (agent wizard, done). Unblocks AGO-90 (export/import actions), AGO-99 (promotion), AGO-73 (squads), AGO-156 (agent versions with quality snapshots), AGO-194 (pack import).
- Risk: **high** (migration, RLS, a database guard on who can receive tasks; accepted by the owner via the coordinator).

## Overview
"As an owner, I want to edit, duplicate and archive agents and set model and thinking effort so that I can tune them."

Acceptance criteria (verbatim):
- Edits are versioned and audited
- Archived agents cannot receive tasks
- Duplicate copies skills and capabilities but starts in Strict mode
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Humans decide: only owners can edit, duplicate, archive or unarchive; an agent credential is rejected on all four actions (AGO-148 `requireHumanRequest`). Editing never changes `mode`, `status`, skills or capability grants (see Scope).

## Scope
In: edit name, role, model, **thinking effort**, prompt and daily budget; duplicate; archive; unarchive; version history and audit trail; the database guard that stops tasks going to an archived agent; UI on `/app/agents` (row actions, an Archived section) and `/app/agents/[agentId]` (edit form + history).
Out (follow-ups below): editing an agent's skills or capability grants after creation (permission-affecting; needs its own approval design), using `thinking_effort` in the worker, a worker claim-path check for archived agents, quality snapshots on versions (AGO-156), restoring an old version.

## Implementation details
**Shared** (`packages/shared/src/agents/`): `agent-limits.ts` (zod-free) gains `AGENT_THINKING_EFFORTS` (`low`/`medium`/`high`, default `medium`), labels, messages and the edit-draft checks; `agent-edit-schemas.ts` holds the strict zod schemas `updateAgentSchema`, `agentRefSchema` (archive, unarchive) and `duplicateAgentSchema`, plus the `AgentVersion` type. None has a `mode`, `status`, `tier` or `archivedAt` field, so a tampered request cannot set them.

**Web** (`apps/web/src/features/agents/`): `edit-agent.ts` (logic and error mapping behind an `AgentEditor` interface so it is testable without a database), `agent-editor.ts` (server-only; the RPC calls), actions `updateAgentAction`, `duplicateAgentAction`, `archiveAgentAction`, `unarchiveAgentAction` in `actions.ts` (human-only check, `parseInput`, owner check, revalidate), `AgentEditForm.tsx`, `AgentRowActions.tsx`, `AgentVersionList.tsx`, route `/app/agents/[agentId]`.

**Database**: migration `20261113050001_ago_89_edit_duplicate_archive_agents.sql` (built; rollback and pgTAP `supabase/tests/agent_versions.test.sql`, 60 assertions). See below. **Routes**: `/app/agents/[agentId]` (edit form for owners, read-only for others, version history) and the agent list gains row actions (owners) and an Archived section.

## Boundaries
- **Always:** scope by `workspace_id`; owner role checked in the action, the library and the RPC; validate with Zod at the action; write every change through an RPC and let a trigger write the version row; keep the version table append-only.
- **Ask first:** granting more than owner-only update on `agents`; any change to `mode` or `status`.
- **Never:** let an agent credential call these actions; let a duplicate start in anything but `strict`; let a client pick the version number, `changed_by` or the tier of a copied capability.

## API changes
No HTTP routes. Four server actions (owner only, human only): update, duplicate, archive, unarchive. RPCs: `update_agent`, `duplicate_agent`, `archive_agent`, `unarchive_agent` (authenticated, SECURITY INVOKER).

## Database changes (as built; migration `20261113050001_ago_89_edit_duplicate_archive_agents.sql` + rollback)
Built as planned below, with these additions found while building: (1) AGO-107 let **members** update agents (name, description, archived_at), which would have let a member rewrite a prompt or archive an agent, so `agents_update_member` is replaced by `agents_update_owner` and the update grant is now exactly name, role, model, thinking_effort, prompt, daily_budget_cents, archived_at (`description` is no longer directly editable: it was unaudited and has no UI); (2) the version trigger compares only the tracked columns and `archived_at`, so worker writes to `status` or `run_limits` create no version; (3) a direct edit of an archived agent is refused by the trigger as well as by the RPC; (4) the tasks guard fires on insert and when `agent_id` changes, so an existing assignment survives the archive; (5) `run_limits` has no grant (AGO-166) so a copy starts with worker defaults; (6) the catalog tests (`core_schema`, `core_schema_qa`, `rls_catalog`, `rls_every_table`, `rls_every_table_qa`) and `docs/database.md` were updated for the new table, policy and functions.

- `agents.thinking_effort text not null default 'medium' check in ('low','medium','high')`, `agents.version integer not null default 1`.
- `agent_versions` (append-only, like `skill_versions`): `workspace_id, agent_id, version, change_kind (create|edit|archive|unarchive), changed_fields text[], name, role, model, thinking_effort, prompt, daily_budget_cents, changed_by (member id), created_at`. A trigger on `agents` writes a row on insert and on every change to a tracked column or `archived_at`, so no code path edits an agent without leaving a version. UPDATE/TRUNCATE raise; DELETE only through the parent cascade. `prompt` is stored in full (untrusted text, never executed).
- `update_agent(...)`: owner check, optimistic lock (`p_expected_version`; stale = error), updates only the six editable columns, returns the new version. Column-level update grants on `agents` cover only those columns and `archived_at`; `mode`, `status`, `department_id` and identity columns stay ungranted.
- `duplicate_agent(workspace, agent, name)`: copies the editable columns, `agent_skills` and `agent_capabilities` (tier read again from the catalog: a capability now disabled is skipped, tier 3+ forced to `approval`); the new agent takes the column default `mode = 'strict'` and the function cannot set otherwise; refuses an archived source.
- `archive_agent` / `unarchive_agent`: set / clear `archived_at`; edit and duplicate refuse an archived agent (unarchive first).
- Trigger on `tasks` (insert, update of `agent_id`): raise when the assignee is archived. Existing tasks of an agent archived later keep their assignment (history kept); the worker claim-path check is a follow-up.
- Rollback file removes the triggers, functions, `agent_versions` and the two columns. pgTAP: owner-only, member/viewer refused, a version row per edit, versions immutable, archived assignee refused, duplicate is strict and copies skills and capabilities, cross-workspace isolation.

## Decisions
| Decision | Chosen | By / when |
|---|---|---|
| Risk tier | High | Owner via coordinator, 2026-11-10 |
| Versioning and audit | One immutable `agent_versions` table doubling as the audit log (mirrors `skill_versions`) | Owner via coordinator, 2026-11-10 |
| Thinking effort | Column only (`low`/`medium`/`high`, default `medium`, allowlist in `packages/shared`); runtime use is a follow-up | Owner via coordinator, 2026-11-10 |
| Archive | Reversible by the owner (unarchive) | Owner via coordinator, 2026-11-10 |
| Archived agents and tasks | DB trigger on `tasks` now; worker claim-path check is a follow-up | Owner via coordinator, 2026-11-10 |
| Edit scope | Skills and capability grants are not editable here | Worker, keeps permission changes out of this ticket; owner can overrule |
| Concurrent edits | Optimistic lock on `version` | Worker |
| Who may update `agents` | Owners only (replaces the AGO-107 member policy) | Worker, closes a member write path; owner can overrule |
| Version author label | "You" or "A workspace <role>" (members have no display name yet) | Worker |

## Dependencies on other tickets
AGO-141 (agents columns, wizard, `agentCreator`), AGO-128 (version table pattern), AGO-148 (human-only guard), AGO-94 (model allowlist), AGO-82 and AGO-107 (roles, RLS). The migration needs the schema slot (held by AGO-30 until granted).

## Known limitations
Skills and capabilities cannot be edited after creation yet. Old versions are viewable, not restorable. Thinking effort is stored but not yet used by the worker. A task already assigned to an agent that is archived afterwards keeps its assignment.

## Testing notes
Unit: shared schemas and draft checks, `edit-agent.ts` error mapping and owner/agent-credential paths, UI components (roles, labels, error focus). pgTAP (under the db lock): see Database changes. E2E (device tester): edit and see the new version, duplicate (Strict, same skills and capabilities), archive (gone from the active list, task assignment refused), unarchive.

## Follow-up tasks
1. Worker: honour `thinking_effort` when calling the model.
2. Worker: refuse to claim or run work for an archived agent (claim-path check; the database guard only covers new assignments).
3. Edit skills and capabilities of an existing agent (with an approval design), and restore an old version (pairs with AGO-156).

## Outcome
(filled at merge)
