# AGO-43 - Add the autonomy dial

Ticket: https://stratyge.atlassian.net/browse/AGO-43
PRs: https://github.com/CodeEx24/ai-agent-office/pull/57
Related: blocked by AGO-34 (policy engine, Done), AGO-148 (identity, Done) · schema slot held by AGO-30 · AGO-99 (new agents start Strict) and AGO-130, AGO-194 build on this
Type: Feature · Risk: High · Status: Merged (record accepted 2026-11-13)

## Overview

Jira AGO-43 (US-041), Epic EP-16 (Autonomy), Wave 2, WS-E Security & Governance. Strict, Standard and Relaxed modes that never let Tier 3 or 4 run on their own. High risk: policy enforcement.

## Acceptance criteria (verbatim)

1. Relaxed mode applies Tier 2 edits to own notes with revert; Tier 3 and 4 still escalate
2. A test attempts to loosen Tier 4 and fails
3. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details (design)

Based on the recommended options of the open decisions (see Decisions).

1. **Modes** (`packages/shared/src/policy/policy-engine.ts`): add `relaxed` to `POLICY_AGENT_MODES`; `parsePolicyAgentMode` still maps any unknown value to `strict`. Steps 4-6 are unchanged; a new step before the grant check changes the result: in `relaxed`, a grant in `approval` mode for `vault.write_own` (tier 2) is allowed (new reason code `allowed_tier2_own_notes`). Steps 4-6 (deny rules, tier 3/4, require_approval rules) stay before any allow, so Relaxed can never loosen Tier 3/4, a deny rule or an approval rule.
2. **Tier 4 cannot be loosened:** a table-driven test runs every mode x every grant mode x every `allow` rule against tier 3 and 4 calls and asserts `escalate` or `deny`, never `allow`; it also asserts no stored value (unknown mode, `allow` rule) lowers the tier.
3. **Own-notes revert** (`apps/worker/src/policy/own-note-revert.ts`; deviation: one worker file, nothing needed in shared): `OwnNoteRevertStore` interface (in-memory impl). `recordOwnNoteEdit` snapshots the previous content and a content hash before an auto-applied edit; `revertOwnNoteEdit` restores it, workspace- and agent-scoped, and fails closed if the note changed since (hash mismatch) or the record belongs to another agent or workspace. No content is logged. The future vault write tool must call these; none exists yet.
4. **Mode source:** `agents.mode` (text, default `strict`) already exists and is not writable by API callers. No setter, UI or migration in this ticket.

Reuse: `evaluatePolicy`, `parsePolicyAgentMode`, the interface-plus-store style of AGO-154 and AGO-148.

## Decisions

| # | Decision | Who / when |
|---|---|---|
| 1 | Relaxed semantics: A (Standard unchanged, Relaxed adds own-notes auto-run with revert; Tier 3/4 escalate in every mode) | owner, 2026-11-13 (recommended-options rule) |
| 2 | Revert as helpers + `OwnNoteRevertStore` interface, in-memory, no migration; persistent revert table is an owner-approved deferral | owner, 2026-11-13 |
| 3 | Record accepted | owner, 2026-11-13 |

## Boundaries

- **Always:** Tier 3 and 4 escalate in every mode; deny wins; unknown mode means strict; scope by workspace_id; no content in logs.
- **Ask first:** a revert table or a mode setter (schema slot), any new dependency.
- **Never:** let an agent change its own mode, loosen Tier 3/4, edit settings or CLAUDE.md.

## API changes

None.

## Database changes

None (this worker does not hold the schema slot). `agents.mode` is free text today; a check constraint and a human-only setter are a follow-up.

## Dependencies on other tickets

AGO-34 (engine), AGO-125 (capability catalog, `vault.write_own`), AGO-30 (schema slot for follow-ups).

## Known limitations

- Revert records live in memory behind an interface until a vault write tool and a table exist.
- No UI or API to set the mode.

## Testing notes

Vitest only: engine mode matrix, Tier 3/4 never allow, own-notes allowed only in relaxed and only for `vault.write_own`, revert round trip, revert refused on cross-agent, cross-workspace or changed note. No DB, no model calls.

## Follow-up tasks

- Mode setter (human-only) and check constraint on `agents.mode` (schema slot).
- Persistent revert table and vault write tool integration (AGO-121).

## Outcome

- Feature guide: [docs/features/autonomy.md](../features/autonomy.md)
