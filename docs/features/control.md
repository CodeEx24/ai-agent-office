# Run control: pause, resume and stop (AGO-86)

A person can pause, resume or stop any agent run. Only a person: agent credentials are refused on the control route, and the database function behind it refuses them too.

## How it works

```
person -> POST /api/runs/:id/control { workspace_id, action } -> request_run_control() -> flag on private.run_checkpoints
                                                                                              |
worker loop reads the flag before EVERY tool call  <-----------------------------------------+
worker control sweep applies stop / resume to runs with no loop running  <--------------------+
```

1. **The route records a request, nothing more.** `POST /api/runs/[id]/control` checks, in order: agent credential (403, plus an `error.raised` event `control_route_rejected`), the body (400), a signed-in member of the workspace (401/403), then calls `public.request_run_control`. A run that is not in a state the action applies to answers 404. Success is 200 `{ id, action, status: "accepted" }`. The function writes no `run_events` and no `runs` row: the flags live in `private.run_checkpoints`, which only the worker can touch.
2. **The loop checks the flag before every tool call.** The check is the first thing `executeToolCall` does, ahead of the `tool_call.requested` event, the policy hook, the approval consume and the tool. Order for one call: **control flag, then policy, then tool** (budget slots in between control and policy when AGO-40 lands). A pause or stop seen there leaves the call untouched in the checkpoint, so a resume runs it from the top with the flag checked again. A flag that cannot be read throws: the attempt fails and is retried, it is never run through (fail closed). The same check runs at the start of each step and after each model answer.
3. **A paused agent makes no further calls within one tool-call boundary.** A pause that arrives while a tool is running lets that one call finish and starts none after it.
4. **Stop is final.** A stop wins over a pause and over a resume. A running run is ended by its own loop at the next boundary; a queued or paused run is stopped by the control sweep. Finalizing a stop (`finalizeStop`) first closes the run's pending approvals as `rejected` with an `approval.decided` event (`denied`, decided by a human); the runtime never writes `approved`. Then the run moves to `stopped` in one conditional update, and the caller that moved it writes `run.stopped` (`stopped_by: human`, `reason: stopped_by_human`) and only then drops the checkpoint, and with it the flag. If that event write fails (or the worker dies) the run is already `stopped` and the flag stays set: the next control sweep lists it, finds nothing to move, and finishes the tail under a row lock, writing `run.stopped` only if no such event exists and then dropping the flag, so the event is written exactly once. The sweep lists a stop only for a queued, paused or `stopped` run (a running run's loop ends it) and a resume only for a queued or paused run, and it first clears the requests of runs that already succeeded or failed, so stale rows never fill its 100-row batch. Nothing moves a run out of `stopped`: `resumeRun` and the approval-expiry wake both refuse a run with a stop request, and every other transition is conditional on a different status.
5. **Resume bypasses nothing.** The route records `resume_requested_at`; the sweep calls `RunControl.resumeRun` as the person who asked, which only moves `paused -> queued`. The woken loop reads each awaiting approval again (pending stays paused, expired is denied) and applies its budget and policy checks as normal. A resume request that names no person is ignored.

## Pieces

| Piece | Where |
|---|---|
| Route and member check | `apps/web/src/app/api/runs/[id]/control/route.ts`, `apps/web/src/features/runs/request-run-control.ts` |
| Human-only guard (reused from AGO-58) | `apps/web/src/lib/auth/human-only.ts`, `apps/web/src/proxy.ts` |
| Schemas and route matcher | `packages/shared/src/runs/run-control.ts` |
| Flags and function | `supabase/migrations/20261114150001_ago_86_run_control.sql` (down script in `supabase/rollbacks/`) |
| Loop check | `apps/worker/src/agent/agent-loop.ts` (`readRunControl`, `executeToolCall`) |
| Stop finalizer | `apps/worker/src/queue/run-stop.ts` |
| Control sweep (5 s timer) | `apps/worker/src/queue/run-control-sweep.ts`, started in `job-queue.ts` |

## Known limitations

- Stopping a `running` run whose worker has died only lands once a retry reclaims the run and its loop sees the flag.
- A stop is noticed at tool-call boundaries: a tool that is already running is allowed to finish.
- No UI yet (AGO-178) and no workspace-wide kill switch (AGO-84).
- The AGO-40 budget check is not in the loop yet. When it merges, the order control, budget, policy, tool needs a test.

## Testing

- `apps/worker/src/agent/agent-loop.control.test.ts`: order, no call after a pause, concurrent pause and stop, fail closed, resume continues.
- `apps/worker/src/queue/run-control-sweep.test.ts`: stop is final, approvals closed, stop beats resume, resume as the asker, a failed `run.stopped` write is finished once by the next sweep, and a live stop is processed behind more than 100 stale requests.
- `apps/worker/src/queue/run-control.integration.test.ts` (live database, under the db lock): the same two cases against Postgres, plus the stop, resume and approval SQL.
- `supabase/tests/run_control.test.sql` (pgTAP) and `scripts/ago-86-rollback.test.mjs` (apply, roll back, re-apply).
- Route and proxy tests under `apps/web`.
