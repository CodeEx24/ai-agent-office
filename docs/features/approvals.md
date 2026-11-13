# Approval requests (AGO-21)

When the policy engine answers `needs_approval` for a tool call, the worker records a **pending approval**, pauses
the run, and waits for a human. If nobody answers in time the approval becomes `rejected` and the agent is told.
A human is always in the loop: nothing here lets an agent or the loop approve anything.

## What happens, in order
1. The agent asks for a tool. The policy check runs before the tool, as always.
2. Decision `needs_approval` (tier 3 and 4, or any call a policy escalates): the loop writes a row in
   `public.approvals` (`status = pending`, the tool name as `action`, the payload **hash**, `expires_at`), then emits
   `approval.requested` with the same `approval_id`, then saves the call as `awaiting_approval` and pauses the run
   (`pauseReason: approval_required`). The tool does not run.
3. Tier 0 and 1 calls, and calls the policy denies, never reach this branch: no row exists for them.
4. If nobody decides before `expires_at`, the row moves to `rejected`, `approval.decided` is written
   (`outcome: expired`, `decided_by: timeout`), and the run is woken so the model hears the call was **not run**
   (`approval_expired`).

## Ids and retries
`approval_id` is derived from `(run id, step, call id)`, so a crashed attempt that raises the same call again finds
the same row instead of creating a second one. A row bound to a different run or payload hash is a conflict, never
reused.

## Expiry: two paths, one result
- **Sweeper** (`apps/worker/src/approvals/expire-approvals.ts`): an interval timer (default 30 s) that starts and
  stops with the job queue. One conditional update moves due `pending` rows to `rejected`; only the caller that
  moved a row writes the event and wakes the run, so two sweeps cannot both act.
- **Resume-time check** (`agent-loop.ts`): a resumed call whose approval is `pending` but already past `expires_at`
  is expired and denied right there, so timeout means deny even if the sweeper is late or down.

The wake-up uses `RunControl.resumeAfterApprovalExpiry`: no actor, no route, it writes `run.resumed` with
`resumed_by: timeout`, and the only thing the resumed run can do is deny. `resumeRun` is unchanged and still
requires a human.

## What does not run
The tool runs in no path that is not an honoured approval. Today none is honoured: an `approved` row is closed
`approval_not_granted` (fail closed) until AGO-47 adds payload-hash binding and single use. Missing row, wrong hash,
another workspace, or no store are all denials.

## Not in this ticket
- The decide routes (approve or deny) and the inbox UI: AGO-58 and AGO-37.
- Executing an approved call: AGO-47.
- The full "timeout means deny" guarantee across the system: AGO-51.

## Operating notes
- No migration: this uses `public.approvals` from AGO-74 (RLS from AGO-107). `rejected` is a worker-written status.
- `APPROVAL_STATUS` lives in `packages/shared`. Rollback is a plain revert; rows left behind are harmless.
- Known gaps: the `approval.decided` event can be missing if the update succeeds and the event write fails (logged,
  sent to the error tracker); a run still `running` when its approval expires is denied on its next resume instead.
