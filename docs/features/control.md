# Run control: pause, resume and stop
Tickets: AGO-86 (created)

## What it does
A person can pause, resume or stop any agent run. Only a person: agent credentials are refused on the control route, and the database function behind it refuses them too. The web app only records the request. The worker makes it happen.

## Screens
None yet. The route `POST /api/runs/[id]/control` (body `{ workspace_id, action: "pause" | "resume" | "stop" }`) is the only entry point. The right-click controls UI is AGO-178.

Answers: 200 `{ id, action, status: "accepted" }`; 400 bad input; 401 not signed in; 403 agent credential or not a member; 404 the run is not in a state the action applies to (or is already stopped); 500 `control_unavailable`.

## Data model
Three nullable columns on `private.run_checkpoints` (worker-only table, no grants for web roles): `pause_requested_at`, `stop_requested_at` (never cleared: stop is final), `resume_requested_at`, plus `control_requested_by` (the person, audit only). `public.runs.status` gains the free-text value `stopped`. No new table. `public.request_run_control(p_workspace_id, p_run_id, p_action)` is a `SECURITY DEFINER` function, executable by `authenticated` only. It writes no `run_events` and no `runs` row.

## Data flow
```mermaid
flowchart LR
  Person --> Route["POST /api/runs/[id]/control"]
  Route --> Fn["public.request_run_control"]
  Fn --> Flags[("private.run_checkpoints flags")]
  Flags --> Loop["agent-loop executeToolCall"]
  Flags --> Sweep["run-control-sweep (5 s)"]
  Loop --> Stop["run-stop finalizeStop"]
  Sweep --> Stop
  Sweep --> Resume["RunControl.resumeRun"]
  Stop --> Runs[("runs status stopped")]
  Stop --> Events[("run_events run.stopped")]
  Resume --> Runs
```

## Main functions and files
| function / component | file | role |
|---|---|---|
| `POST` | `apps/web/src/app/api/runs/[id]/control/route.ts` | Agent guard, Zod input, member check, one call to the function |
| `requestRunControl` | `apps/web/src/features/runs/request-run-control.ts` | Calls the RPC with the caller's own session |
| `runControlBodySchema`, `isRunControlRoute` | `packages/shared/src/runs/run-control.ts` | Body schema and the path matcher for the rejection event |
| `request_run_control` | `supabase/migrations/20261114150001_ago_86_run_control.sql` | Human session and member check, then sets one flag. Down script: `supabase/rollbacks/20261114150001_ago_86_run_control.down.sql` |
| `readRunControl`, `executeToolCall` | `apps/worker/src/agent/agent-loop.ts` | Reads the flags first thing in every tool call; also at step start and after each model answer |
| `readControl`, `listControlRequests`, `clearStaleControlRequests`, `finishStopTail` | `apps/worker/src/agent/checkpoint-store.ts` | Flag reads, sweep listing, stale cleanup, finishing a stop tail under a row lock |
| `finalizeStop` | `apps/worker/src/queue/run-stop.ts` | Closes approvals, moves the run to `stopped`, writes `run.stopped`, drops the flags |
| `sweepControlRequests`, `createControlSweeper` | `apps/worker/src/queue/run-control-sweep.ts` | Applies stop and resume to runs with no loop; started in `job-queue.ts` |
| `rejectPendingForRun` | `apps/worker/src/approvals/approval-store.ts` | `pending` to `rejected` for a stopped run |
| `markStopped`, `resumeRun` | `apps/worker/src/queue/run-store.ts` | Conditional status updates; `resumeRun` refuses a run with a stop request |
| human-only guard | `apps/web/src/proxy.ts` | Reuses the AGO-58 guard and rejection event for the control path |

## Rules and edge cases
- Order for one tool call: control flag, then policy, then tool (budget slots between control and policy when AGO-40 lands, with an ordering test then). A pause or stop leaves the call unrun in the checkpoint, so a resume runs it from the top. A flag that cannot be read throws and the attempt is retried: fail closed.
- A tool already running when a pause or stop arrives finishes; none starts after it.
- A stop wins over a pause and over a resume. A running run is ended by its own loop; a queued or paused run by the control sweep. Nothing leaves `stopped`: `resumeRun` and the approval-expiry wake both refuse a run with a stop request.
- Stopping closes the run's pending approvals as `rejected` with an `approval.decided` event (`denied`, by a human). The runtime never writes `approved`.
- The mover of the run writes `run.stopped` (`stopped_by: human`, `reason: stopped_by_human`) and then drops the checkpoint. If that write fails, the run stays `stopped` with the flag set, and the next sweep finishes it under a row lock. Known limit: a narrow window between `markStopped` and the unlocked write can let a second worker write `run.stopped` twice (see the ticket's follow-up). The run state and approvals are unaffected.
- The sweep first forgets requests of finished runs, so stale rows never fill its 100-row batch. A resume request naming no person is ignored; the resume flag is cleared after one attempt.
- Resume bypasses nothing: it only moves `paused` to `queued`; the loop re-reads approvals, budgets and policy.
- A `running` run whose worker died is only stopped when a retry reclaims it.

## How to extend it
- New action: add it to `RUN_CONTROL_ACTIONS` in `packages/shared/src/runs/run-control.ts`, a branch in `request_run_control` (new migration), and its handling in `agent-loop.ts` and the sweep.
- Another control path to guard: extend `isRunControlRoute` so the proxy records the rejection.
- Budget check: put it between `readRunControl` and the policy hook in `executeToolCall`, and add the four-step ordering test next to `agent-loop.control.test.ts`.
- Tests: `agent-loop.control.test.ts`, `run-control-sweep.test.ts`, `run-control.integration.test.ts` (live DB, db lock), `supabase/tests/run_control.test.sql`, `scripts/ago-86-rollback.test.mjs`, and the route tests under `apps/web`.
