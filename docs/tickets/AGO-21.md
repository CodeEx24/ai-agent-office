# AGO-21 - Build the approval request flow (US-035)

## Links
- Ticket: https://stratyge.atlassian.net/browse/AGO-21
- PRs: (pending)
- Related: AGO-34 (policy engine, done), AGO-30 (checkpoint, pause, resume, done); unblocks AGO-37 (inbox UI), AGO-47 (payload-hash binding, single use), AGO-51 (timeout means deny), AGO-58 (human-only routes)

Status: In progress · Type: Feature · Risk: high (human-in-the-loop invariant, `approvals` table) · Wave 2

## Overview
Today the loop only emits an `approval.requested` event when a call escalates, then pauses the run. No `approvals` row exists, nothing expires, and a resumed run treats the call as denied. This ticket makes the request real: a pending row, a run that waits, and a sweep that expires old requests into a rejected state and tells the agent.

## Acceptance criteria (verbatim)
- [ ] Given an escalated call, when raised, then a pending approval exists and the run waits
- [ ] An expired approval becomes rejected and the agent is told
- [ ] No approval exists for a Tier 0 or 1 call
- [ ] Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details (proposed)
1. **Approval store port** (`apps/worker/src/approvals/`): `ApprovalStore` with a pg implementation. All statements scoped by `workspace_id`.
   - `create({workspaceId, runId, agentId, approvalId, action, payloadHash, expiresAt})`: insert `status = 'pending'`. Idempotent on `(workspace_id, id)` so a crash retry does not duplicate. `action` is the tool name only (no payload stored).
   - `expireDue(now)`: one conditional update `pending and expires_at <= now -> rejected`, returning the rows moved (atomic, so two sweeps cannot both act).
   - `get(workspaceId, approvalId)`: for the resume path.
2. **Loop** (`agent-loop.ts`): when a call needs approval, create the row **before** emitting `approval.requested`, with the same `approval_id`, the tier and TTL it already uses. The id is derived, not stored: `approvalIdFor({runId, step, callId})` is a deterministic UUID, so a retry meets the same row and no checkpoint schema change is needed (deviation from the first plan, 2026-11-13). The call is `awaiting_approval`, the run pauses (existing behaviour). Tier 0 and 1 calls never reach this branch (the loop only creates a row when the decision is `needs_approval`); a test pins that.
3. **Expiry** (`apps/worker/src/approvals/expire-approvals.ts`): a sweep, run by an interval timer that starts and stops with the job queue (pg-boss is created with `schedule: false`, so it is not used for this; deviation from the first plan, 2026-11-13), runs `expireDue`. For each expired row it writes `approval.decided` (`outcome: expired`, `decided_by: timeout`, payload hash) and then wakes the run through the AGO-30 resume path, with a system actor used for expiry only (it can only produce a denial). On the resumed run, the `awaiting_approval` call reads its approval: `rejected` closes the call with `approval_expired` and the model is told "the approval request expired, the call was not run". Nothing runs.
4. **Resume with no decision**: a resumed call whose approval is still pending and not expired re-pauses (no new request, no new event). A call whose approval is pending but **past `expires_at`** is closed `approval_expired` (deny) right there, so timeout means deny even when the sweep is late or down; the resume path expires that row itself (same conditional update, same `approval.decided` event, written once). A missing or unreadable row is a deny (`approval_not_granted`). Approved handling is out of scope (see Known limitations). The tool runs in no non-approved path.
5. **Docs**: `docs/features/approvals.md`.

## Boundaries
- **Always:** scope by `workspace_id`; policy check stays before every tool call; keep the payload hash, never store the payload; emit events through the emitter; timeout means deny.
- **Ask first:** any migration (none planned), any change outside owned paths.
- **Never:** let an agent or the loop approve; execute a call because a row exists; edit `run_events`.

## API changes
None (no HTTP route). New worker-internal seams: `ApprovalStore`, `expire-approvals` job.

## Database changes
None planned: builds on `public.approvals` from AGO-74 (status is free text, default `pending`; RLS from AGO-107 lets humans only decide pending to approved/denied). `rejected` is a worker-written value for expiry. If a CHECK constraint on status or a worker grant turns out to be needed, that is a SCOPE question, not an edit.

## Dependencies on other tickets
AGO-34 (escalate decision), AGO-30 (checkpoint, pause, resume). Consumers: AGO-37, AGO-47, AGO-51, AGO-58.

## Known limitations
- No decide path (approve or deny) here: the human-only decision routes are AGO-58 and the inbox UI is AGO-37. An approved row is **not** executed by this ticket; execution needs payload-hash binding and single use (AGO-47), so the safe default (deny, `approval_not_granted`) stays. **Dependency on AGO-47:** until it lands, an approved row never lets a call run (fail closed); the end-to-end "approve and run" path arrives with AGO-47 and the decide routes (AGO-58).
- AGO-51 owns the full "timeout means deny" guarantee; this ticket only expires pending rows.

## Testing notes
Unit tests with fakes (no model calls). Integration tests against the local stack under the db lock (`node scripts/db-lock.mjs acquire AGO-21`, `supabase db reset` first). Cases: escalated call creates one pending row and the run is paused; a retry does not duplicate; Tier 0, 1 and denied calls create no row; expiry flips pending to rejected exactly once and emits `approval.decided`; resumed run is told and does not run the tool; workspace isolation.

Where the cases live:
- `apps/worker/src/agent/agent-loop.approvals.test.ts`: AC1 (row on escalation, request event with the same id, run pauses, retry makes no second row), AC3 (no row for Tier 0, 1, denied or unknown-tool calls), AC2 (resume closes `approval_expired`, resume-time check denies a pending approval past `expires_at`, exactly one `approval.decided`), and the fail-closed paths (`approved` stays `approval_not_granted`, `denied`, missing row, wrong hash, other workspace, no store).
- `apps/worker/src/approvals/expire-approvals.test.ts`: the sweep flips to `rejected`, writes `expired`/`timeout`, wakes the run, once only, and survives event or wake failures.
- `apps/worker/src/approvals/approval-store.integration.test.ts`: the real `public.approvals` table (idempotent create, workspace isolation, conditional expire exactly once, `expireDue`).
- `apps/worker/src/queue/run-control.test.ts` and `packages/shared/src/events/run-events.test.ts`: the system wake-up (`resumed_by: timeout`) and that an agent still cannot resume.
- A mutation check was run: making the resume-time check ignore `expires_at` fails the "past expires_at" test and nothing else.

Known accepted gaps: the `approval.decided` event can be missing if the sweep's update succeeds and its event write fails (logged and sent to the error tracker); a run that is not yet `paused` when its approval expires is not woken by the sweep (it is denied on its next resume).

## Decisions
| # | Decision | By | When |
|---|---|---|---|
| 1 | Expiry status value is `rejected` (from the AC); the event outcome stays `expired`; no migration | owner (via coordinator) | 2026-11-13 |
| 2 | Approved rows stay deny-by-default (fail closed) until AGO-47; no decide routes here | owner (via coordinator) | 2026-11-13 |
| 3 | A still-pending, unexpired approval re-pauses on resume; pending but past `expires_at` is denied `approval_expired` on resume, even if the sweep is late or down, with a test | owner (via coordinator) | 2026-11-13 |

## Follow-up tasks
None yet.

## Outcome
(filled at merge)
