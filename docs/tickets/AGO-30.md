# AGO-30 - Add checkpoint, pause and resume

Ticket: https://stratyge.atlassian.net/browse/AGO-30
PRs: https://github.com/CodeEx24/ai-agent-office/pull/54
Related: blocked by AGO-167 (Done) - unblocks AGO-21 (approval request flow) and AGO-131 (durable approvals)
Type: Feature (US-037) - Risk: High (runtime, migration, stored run data) - Status: In review

## Overview
Epic EP-02 (Agent runtime), wave 2. Today the agent loop (AGO-167) keeps its whole state in memory: tool results, the
step count, the token count and the loop-detection counters. If the worker dies mid-run, pg-boss retries the job and the
loop starts over from step 1, which repeats tool calls that already ran. A run that stops for an approval is marked
`paused` but nothing can bring it back (AGO-167 left "resume is AGO-30"). This ticket adds a durable checkpoint, a
pause request, and an idempotent resume.

## Acceptance criteria
Copied verbatim from the ticket:

1. Given a worker crash mid-run, when restarted, then the run resumes without repeating completed tool calls
2. A paused run holds no open model calls
3. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Testable wording used for the tests: (1) after a simulated crash at any point between two tool calls, the second attempt
executes each tool call at most once in total and the run finishes with the same result as an uninterrupted one;
(2) when the run reports `paused`, the model provider has zero requests in flight and none is started until resume.

## Assumptions
1. (code) Tool output is never stored today, events carry hashes only (AGO-164). So the event log cannot rebuild the
   loop state, and a checkpoint must store the scrubbed tool results itself.
2. (code) The model's response for a step is not stored either. A crash between two tool calls of one step would make the
   model be asked again and it could ask for different calls. So the checkpoint also stores the step's calls.
3. (ticket) The approval decision flow is AGO-21, not built yet. Resume must never treat a missing decision as an
   approval.
4. (brief) No `apps/web` or UI change: owned paths are the worker, the queue, shared run-state schemas, one migration.

## Design
**Checkpoint store.** New table `private.run_checkpoints` (see "Table location"), one row per run, primary key
`(workspace_id, run_id)`, composite foreign key to `runs`. Columns: `state jsonb` (validated by a Zod schema in
`packages/shared`, version field, under 1 MB), `pause_requested_at`, `created_at`, `updated_at`. RLS on; no grant for
`authenticated`, `anon` or `service_role` (the content is tool output; only the worker's database role reads and writes it). Reversible: `supabase/rollbacks/<ts>_ago_30_run_checkpoints.down.sql`.
pgTAP test for isolation (workspace A cannot read B's row, `authenticated` has no access).

**What the state holds** (`runCheckpointStateSchema`, shared): `steps`, `tokens`, loop-detection counters, the history
window (the records the loop would still show the model; older ones were already dropped from context, so they are not
kept), and the current step's calls, each `{call_id, name, input, status: pending | started | done}` plus, for `done`,
the stored result record. Size is bounded (history window, per-record cap = the existing 20,000-char tool result cap, total cap).
Inputs and results go through `scrubString` first.

**Write points** (a `CheckpointStore` port with a Postgres adapter, injected into `createAgentLoop`):
1. after the model answers a step: the step's calls, status `pending`, tokens;
2. before a tool executes: that call `started`;
3. after it finishes (ok or error): `done` with the result record, and the loop counters.
The checkpoint is written before the matching `tool_call.*` event that follows it, so the log never claims more than
the checkpoint can replay.

**Resume** (same code path for a crash retry and for a paused run). `execute()` loads the checkpoint if present,
restores steps, tokens, history and counters, and continues the open step: `done` calls are skipped (their stored result
is reused, no policy check or execute), `pending` calls run through the normal policy path, `started` calls follow the
in-flight rule below. If the step is complete it goes on to the next model call. A run with no checkpoint starts fresh.
Wall time restarts per attempt (the job's own expiry still bounds an attempt); steps and tokens carry over, so a
crash-and-resume loop cannot escape the AGO-166 limits.
- Crash path: pg-boss retry -> `claimRun(allowStaleReclaim)` (existing) -> `execute` restores. New event `run.recovered`
  `{step, completed_calls}` (additive, shared events list).
- Paused path: new `RunStore.resumeRun` (`paused -> queued`, only from `paused`) and a worker-side `resumeRun` service
  that emits `run.resumed {resumed_by: "human"}` and enqueues the job with a fresh singleton key. It takes the human actor
  as an argument and refuses anything else. No HTTP route in this ticket (that is the approval/control UI work,
  AGO-21); the service is the seam they call.

**Pause.** (2026-11-13 deviation: a worker service `requestRunPause` replaces the planned SQL function
`request_run_pause`. A new function executable by `authenticated` would change the pinned function lists in the existing
pgTAP tests and open a second write path; the control UI that calls the service is AGO-21's. Owner told: in the report.)
The service sets `pause_requested_at` (only for a `queued` or `running` run). The loop checks the flag at the top of each step and after the model answers, before
any tool runs; it never aborts an in-flight model call. On seeing the flag it writes the checkpoint, emits `run.paused`
`{requested_by: "human", reason: "user_pause"}` and returns `paused` after every await has settled, so a paused run holds no open model
call. An approval-gated call (tier 3/4) keeps today's behaviour (pause with `approval_required`) and is stored as the
pending call.

**Pending approval on resume.** Fail closed. (2026-11-13 deviation: no `ApprovalDecisionSource` port in this ticket.)
A stored call that is `awaiting_approval` is recorded as denied (`approval_not_granted`) when the run resumes, with a
`tool_call.failed` event and an error result for the model, and the rest of the step goes on. Nothing resumes into
execution of an unapproved call. AGO-21 adds the decision source and the approved path (it must verify the stored
`payload_hash` against the call); that is a follow-up, not part of this ticket.

**Table location.** (2026-11-13) `private.run_checkpoints`, not `public`: tool results must not be readable by workspace
members through the Data API, and the existing public-table pgTAP checks stay valid. The worker connects as `postgres`
(the table owner). Checkpoints are deleted when a run ends (succeeded or failed); the event log keeps the audit trail.

**Invariants kept.** Workspace-scoped statements everywhere; policy check before every tool call (resume re-checks any
call that has not run; a `done` call already passed it); `run_events` stays append-only (no event edits); an agent can never
resume (resume is human only); timeout means deny; nothing secret in the checkpoint (scrubbed, no model credential in
this module).

**Edge cases tested.** Crash before any checkpoint (fresh start); crash after step checkpoint, before the first tool; crash between tool
calls; crash after the tool ran but before `done` was written (the in-flight rule); duplicate resume (second `resumeRun`
is a no-op); resume of a run that is not paused; corrupt or wrong-version state (fail the run non-retryably, never
guess); limits carried over; the paused run has zero open model calls; workspace isolation.

## Decisions
| decision | options | choice | who / when |
|---|---|---|---|
| Record accepted | accept / changes | Accepted (AGO-30-q1) | owner, 2026-11-13 |
| Checkpoint storage | rebuild from `run_events` / new table | New table `run_checkpoints` (events carry hashes only) | agent, from the code, 2026-11-13 |
| Checkpoint granularity | per step / per tool call | Per tool call (AC1 needs it) | agent, 2026-11-13 |
| Pause entry point | worker service only / plus web route / SQL function | Worker service only (owned paths exclude `apps/web`; no SQL function, to keep the pinned function lists in the pgTAP tests unchanged) | agent, 2026-11-13 |
| Table schema | public / private | `private`: keeps tool results off the Data API and the public-table pgTAP checks valid | agent, 2026-11-13 |
| Pending approval on resume | re-run as approved / deny until a decision exists | Deny until AGO-21 supplies decisions (human in the loop); no decision-source port in this ticket | agent, 2026-11-13 |
| A call `started` but not `done` at crash | see AGO-30-q2 | A - never re-run; record an outcome-unknown error result | owner (recommended option), 2026-11-13 |
| Pause while a model call is in flight | see AGO-30-q3 | A - let the model call finish, pause before any tool runs | owner (recommended option), 2026-11-13 |

## Implementation notes (2026-11-13)
- Shared: `packages/shared/src/runs/checkpoint.ts` (state schema, `parseRunCheckpointState`), event `run.recovered`.
- Database: migration `20261113040001_ago_30_run_checkpoints.sql` (+ rollback, pgTAP `run_checkpoints.test.sql`).
- Worker: `agent/checkpoint-store.ts` (port, Postgres adapter, no-op), `agent/agent-loop.ts` (save points, restore,
  pause, in-flight rule), `queue/run-control.ts` (`requestRunPause`, `resumeRun`), `queue/run-store.ts`
  (`resumeRun`, `revertResume`), `queue/run-processor.ts` (pause reason, checkpoint cleanup), wiring in `agent/wire.ts`.
- The result record's `input:` preview is now scrubbed (it is stored in the checkpoint); found by a test.
- Docs: `docs/features/runs.md`.

## Known limitations / follow-ups
- No HTTP route or UI for pause and resume (AGO-21 calls `requestRunPause` and `resumeRun`).
- A resumed run with a call awaiting approval denies it; the approved path needs AGO-21's decision source and a
  check of the stored `payload_hash`.
- `run.recovered` is also written when a paused run is resumed (it means "picked up from a saved state").
- A call stored as `started` is never re-run, so a tool that crashed the worker is reported as outcome unknown
  rather than retried.

## Outcome
Filled at merge.
