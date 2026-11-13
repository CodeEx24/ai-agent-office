# Autonomy dial (AGO-43)

Each agent runs in one mode, stored in `agents.mode` (default `strict`; an unknown value is read as strict). People set the mode; no agent can.

| Tier | Strict | Standard | Relaxed |
|---|---|---|---|
| 0-1 | runs | runs | runs |
| 2 | asks a human | runs if the grant is automatic | runs if the grant is automatic; own-notes edits (`vault.write_own`) also run when the grant is approval mode, with a revert record |
| 3-4 | asks a human | asks a human | asks a human |

Tier 3 and 4 always escalate, in every mode, whatever the grants or `allow` rules say. A deny rule or a `require_approval` rule still wins over Relaxed. The proof is `packages/shared/src/policy/autonomy-dial.test.ts` (every mode x grant mode x capability x allow rule).

## Reverting own-note edits

`apps/worker/src/policy/own-note-revert.ts`: the vault write tool must call `recordOwnNoteEdit` before it writes, and `revertOwnNoteEdit` undoes it. A revert is refused for another agent or workspace, a second revert, or when the note changed after the edit.

## Not built yet

- A person-only way to set the mode, and a check constraint on `agents.mode` (needs the schema slot).
- A persistent revert table and the vault write tool (records are in memory behind `OwnNoteRevertStore`; owner-approved deferral).
