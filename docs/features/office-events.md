# Office events: how run events change the office

Ticket: AGO-124 (EP-07). Code: `packages/shared/src/office/`. Built on the typed run events of AGO-164 (`packages/shared/src/events/run-events.ts`), which stay the single source of event types.

The office (agent cards, the 3D floor, the run view) never reads the database directly. It reads **office state**, and office state is a pure fold of `run_events` rows. This page is the contract: what each event does, how to rebuild the state, and what a consumer must handle.

## The input: `OfficeEventRecord`

One `run_events` row plus the run's `agent_id`:

| Field | Meaning |
|---|---|
| `id`, `workspace_id`, `run_id` | row identity and tenant. A row of another workspace is never applied. |
| `agent_id` | added by the loader from `runs` (AGO-126 / AGO-142), so a row attributes itself. |
| `seq` | per-run sequence from the database (1, 2, 3, no gaps within a run). |
| `type`, `payload` | the stored columns. `payload` is `{ version, ...fields }`. |
| `created_at` | ISO time with offset. |

`run_events` is append-only, so the contract has no update or delete event.

## Order, N and the cursor

- `seq` is **per run**. Correctness comes from folding each run in `seq` order; the order between runs does not change the result.
- The workspace **feed order** is `(created_at, id)` (`compareFeedOrder`, `sortFeed`). It only defines "the last N" and the cursor.
- **N** = the last N rows of one workspace in feed order: `selectTail(rows, n)`.
- The **cursor** is `{ created_at, id }` of the last applied row (`state.cursor`). A snapshot is the `OfficeState` itself (JSON, `version: 1`, validated by `parseOfficeState`).
- `created_at` is the transaction start, so feed order can differ slightly from commit order across runs. Catch-up should re-query a small overlap before the cursor; duplicates are ignored, so overlap is free.

## Effect of every event type

An effect changes **channels** of the run view. A channel holds the value written by the last event that writes it; an effect reads only its own payload.

| Event | Effect on the run view |
|---|---|
| `run.created` | phase = queued |
| `run.started` | phase = active |
| `run.completed` | phase = completed; clears tool, approval, handoff |
| `run.failed` | phase = failed (detail = reason); error = reason and message; clears tool, approval, handoff |
| `run.paused` | phase = paused (detail = reason) |
| `run.resumed` | phase = active; clears error |
| `run.recovered` | phase = active; step = checkpoint step; clears tool and error |
| `run.stopped` | phase = stopped (detail = reason); clears tool, approval, handoff |
| `run.limit_reached` | error = `limit_<steps/tokens/time>` (phase unchanged; a later stop or fail ends the run) |
| `run.loop_detected` | error = `loop_detected` (phase unchanged) |
| `context.cut` | none (informational) |
| `step.started` | step = n; clears handoff |
| `step.completed` | none |
| `tool_call.requested` | tool = in-flight call; clears handoff |
| `tool_call.started` | none |
| `tool_call.completed` / `tool_call.failed` | clears tool |
| `policy.decision` | `deny` clears tool; `allow` and `needs_approval` change nothing |
| `approval.requested` | approval = open request (id, call, tier, expiry) |
| `approval.decided` | clears approval; `denied` and `expired` (timeout means deny) also clear tool |
| `budget.usage` | none |
| `budget.exceeded` | error = `budget_<reason>` (phase unchanged) |
| `handoff.created` | handoff = open, to agent |
| `handoff.accepted` | handoff = accepted, by agent |
| `error.raised` | error = code, message, retryable |
| `message.emitted` | message = role and summary (data only) |

"None" events still advance the run's `last_seq`. The table is a mapped type over `RunEventType` (`OFFICE_EVENT_EFFECTS`): adding an event type fails the build until it has an effect.

## Agent state: the six states

`selectAgentStates(state, agentIds?)` derives, per agent, one of `idle`, `working`, `thinking`, `collaborating`, `waiting_on_you`, `error_or_paused`. It is a pure function of the runs and is not stored.

For one live run: open approval → `waiting_on_you` (the card opens `approval_id`); paused → `error_or_paused`; queued → `idle`; open handoff → `collaborating`; a call in flight → `working`; otherwise `thinking`. The agent a live run hands off to (not yet accepted) is `collaborating` too. An agent with several live runs takes the highest of: `waiting_on_you` > `error_or_paused` > `collaborating` > `working` > `thinking` > `idle`. With no live run, the latest ended run decides: completed → `idle`, failed or stopped → `error_or_paused` (stays until the agent's next run).

## Replaying rows (what the reducer guarantees)

`applyOfficeEvent(state, row, options?)` is pure, deterministic and never throws:

| Row | Result |
|---|---|
| invalid envelope | `anomalies.invalid` |
| another workspace | `anomalies.foreign`, ignored |
| `seq` already applied | ignored (idempotent) |
| `seq` skips ahead | **not applied**; `state.gaps[run_id] = { after_seq, seen_seq }`. Fetch that run's events after `after_seq`, then apply them; the gap clears itself |
| unknown type, or `version` newer than this reader | `anomalies.unsupported`; the row's `seq` still advances |
| known type, invalid payload (including unknown keys) | `anomalies.invalid`; `seq` still advances |

A run first seen live must start at `seq 1`. Rebuilding from a window passes `allowWindowStart`, so the run starts wherever the window does and is marked `partial`.

## Rebuilding (AC2)

- **Snapshot + tail** (the normal path): load the snapshot, validate with `parseOfficeState` (null → rebuild), then `applyOfficeEvents(snapshot, rowsAfter(cursor))`. The result equals the state from the full history, exactly, even with overlapping or duplicated rows.
- **Last N events**: `rebuildOfficeState(workspaceId, selectTail(rows, n))`. The input order does not matter. For every channel written by an event inside the window the value equals the full-history value. A run first seen mid-stream is `partial: true`, and a channel whose last write fell outside the window is `null` (unknown). So a run that has been silent for more than N events (for example waiting on an approval for days) needs a snapshot, or a larger N.

Both properties are tested over generated histories (`office-reducer.test.ts`).

## Rules for consumers

- Agent text (`message.summary`, error messages, tool names) is **untrusted data**: render it as plain text; never as markup, a command or a prompt. The reducer never interprets it.
- The office only **displays** approvals; an event never approves anything.
- Treat `anomalies` and `gaps` as health signals (log, catch up), not as errors to throw.
- State keeps every run view; the store (AGO-142) may prune ended runs it no longer needs.
