# AGO-40 - Enforce budgets with hard stops

## Links
- Ticket: [AGO-40](https://stratyge.atlassian.net/browse/AGO-40) (US-040), epic EP-06, wave 2 (Agent Runtime + Guardrails)
- PRs: [#65](https://github.com/CodeEx24/ai-agent-office/pull/65) (draft)
- Related: AGO-164 (typed run event emitter, Done), AGO-167 (agent tool loop, Done), AGO-166 (per-agent run limits, Done), AGO-141 (agent wizard + `daily_budget_cents`, Done), AGO-177 / AGO-56 / AGO-153 (blocked by this ticket)

**Status: In review** · Type: Feature · Risk: high (spend guardrail: money and the human-in-the-loop budget cap)

## Overview
Track model usage and stop runs at three limits: per run (tokens), per agent per day (money) and per workspace per
month (money). A hard stop means: when a call would exceed a budget, the model call is refused BEFORE any spend, the run
stops (never continues silently), the stop is written append-only to `run_events`, and a human can see why. Budgets above
the workspace cap are never accepted and an agent can never raise its own budget.

### Acceptance criteria (verbatim)
- [ ] Given a run reaches its token budget, when the next call is made, then the run stops with a budget event
- [ ] Usage totals match recorded model usage
- [ ] Limits can be set in the agent wizard
- [ ] Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

### What already exists (built on, not rebuilt)
| Piece | Where | State |
|---|---|---|
| Per-run token limit `maxTokens` (per agent override, bounded 1000-5,000,000) | `agent-loop.ts` `stopForLimit`, `run-limits.ts`, `agents.run_limits` | Checked between steps; emits `run.limit_reached` {limit:"tokens"} |
| Per-call usage event `budget.usage` {input_tokens, output_tokens} | `agent-loop.ts` after each model call | Exists, tokens only, no cost |
| `agents.daily_budget_cents` (1-5000) | AGO-141, wizard field "Daily budget" | Stored and validated, never enforced |
| `budgets_usage` ledger (agent row per period, workspace row with `agent_id` null; `token_budget`, `tokens_used`, `cost_budget_cents`, `cost_used_cents`) | AGO-74 / AGO-107 | Table and RLS exist; usage columns are runtime-only (no grant); nothing writes them |

## Implementation details (proposed, assumes the recommended answers below)
1. **Pricing and estimates** (`packages/shared`): a price table (cents per million input / output tokens) keyed by the
   `AGENT_MODELS` allowlist, plus `estimateCallCostCents` / `costOfUsageCents` (round up, never down). A model missing from the
   table is DENIED (owner decision, never "cost 0"). Tests use fake usage; no real model call.
2. **Budget guard** (`apps/worker/src/budget/`): `BudgetGuard.reserve({workspaceId, agentId, runId, estimate})` is called
   before every model call. It checks, in order: per-run tokens (already tracked in the loop), agent daily cents, workspace
   monthly cents. Reserve is one conditional upsert on `budgets_usage` (`cost_used_cents + estimate <= budget`), so two
   parallel runs cannot both pass the last cent. `settle` replaces the reservation with the real cost from the model's
   reported usage; a failed call releases it.
3. **Agent loop hook** (small, additive; AGO-47 edits the same file): one `await budget.reserve(...)` before
   `provider.complete`. A refusal emits `budget.exceeded` {scope: run|agent_daily|workspace_monthly, limit, observed,
   estimate} and ends the run with `end: "limit_reached"` (same terminal path as `run.limit_reached`). A budget store that
   throws or answers nonsense refuses the call (deny on error), never allows it.
4. **Events** (`packages/shared`): new `budget.exceeded` event type next to `budget.usage`; `budget.usage` gains optional
   `cost_cents` and `model`. Append-only through the existing emitter. The run's token-limit stop also keeps
   `run.limit_reached` for steps/time.
5. **Usage totals match** (AC2): the ledger is written only from the same `response.usage` that is emitted in
   `budget.usage`, in one code path; a test sums emitted `budget.usage` events and compares to the `budgets_usage` row.
6. **Caps**: agent daily budget above `AGENT_DAILY_BUDGET_MAX_CENTS` and any workspace budget above the platform workspace
   cap are rejected at save (Zod and database check), never clamped silently. An agent token cannot write budgets
   (existing human-only routes; ledger writes are the worker's service connection only).
7. **Wizard** (AC3): daily budget is already in the wizard (AGO-141). Add an optional "Max tokens per run" field, saved
   through the existing `set_agent_run_limits()` function (AGO-166), shown with its bounds.

## Boundaries
- **Always:** scope every statement by `workspace_id` and agent id together; refuse before spending; emit the stop to
  `run_events`; deny on any error in the budget path; validate with Zod at the boundary.
- **Ask first:** a migration (schema slot is held by AGO-89), edits to `agent-loop.ts` beyond the one hook, new dependencies.
- **Never:** let an agent set or raise a budget; clamp an over-cap budget instead of rejecting it; make a real model call
  in a test; edit approvals code (AGO-47).

## API changes
None public. New shared types/schemas: price table, `budget.exceeded` event, wizard field.

## Database changes
None proposed (reuses `budgets_usage`, `agents.daily_budget_cents`, `agents.run_limits`). If question q2 is answered B, one
migration adds a `reserve_budget` function; it would wait for the schema slot.

## Dependencies on other tickets
AGO-164 (event emitter), AGO-167 (tool loop), AGO-166 (run limits), AGO-141 (wizard + daily budget), AGO-74/107 (`budgets_usage`).
AGO-47 (in flight) edits `agent-loop.ts`: keep the hook one small block and merge origin/main when it lands.

## Known limitations
- Reservation uses a worst-case estimate (context size + `maxOutputTokens`), so a run can be refused slightly early; the
  real cost replaces it on settle.
- Prices are a static table in code; a price change is a code change. No live price fetch.
- The usage and cost dashboard and alerts are AGO-56 / AGO-177.

## Testing notes
Unit (fake store, fake provider with scripted usage): each scope refuses before the call is made; run stops with
`budget.exceeded`; error in the store denies; two concurrent reservations of the last cent admit exactly one. pgTAP/integration
for the conditional upsert under the db lock. Wizard component test for the new field.

## Decisions
| Id | Decision | Chosen | By / when |
|---|---|---|---|
| q1 | Cost estimate and pricing | A - static price table, refuse before each call on a worst-case estimate (uses max output tokens), settle to real cost. A model missing from the table is DENIED, never cost 0. Settling lower releases the difference; settling higher records an overrun event and stops the run | owner via orchestrator, 2026-11-14 |
| q2 | Where usage and limits live | A - reuse `budgets_usage` + `agents.daily_budget_cents`, one atomic conditional upsert, no migration. Live-DB test: two concurrent reservations that together exceed the budget, exactly one wins | owner via orchestrator, 2026-11-14 |
| q3 | Workspace monthly cap when none is set | A - platform default 100000 cents constant in `packages/shared`; owners may only lower it; agents can never change any budget. Documented in `docs/features/budgets.md` | owner via orchestrator, 2026-11-14 |
| q4 | Wizard scope | A - Daily budget plus optional "Max tokens per run" via `set_agent_run_limits()` | owner via orchestrator, 2026-11-14 |
| q5 | Record accepted | A - accepted, with the added checks: every refusal and stop appends a `run_event` with a specific reason code a human can see | owner via orchestrator, 2026-11-14 |

## Deviations from the accepted record (2026-11-14, found while building)
None changes behaviour the owner decided; each is a detail the record left open.
- **Overrun on a final answer completes the run.** The owner said a higher real cost "stops the run". When the model's
  expensive call is its final answer, nothing more will be spent, so the run completes and the overrun event is still
  appended. If the call still wanted tools, the run stops (`call_cost_overran_reservation`).
- **A refusal after `step.started` also appends `step.completed` (outcome error)** so the run view shows a closed step,
  then `budget.exceeded`, then `run.stopped {stopped_by: "budget"}`.
- **A provider rejection releases the reservation; an abort or unknown failure keeps it.** The first cost nothing; the
  second may have been billed, so the ledger over-counts rather than under-counts.
- **A ledger that cannot record the real cost stops the run** (`budget_check_failed`): spend that is not counted is not limited.
- **Cost is rounded UP to whole cents per call**, so the ledger can over-count by up to 1 cent per call.
- **The run token stop keeps `run.limit_reached`** (existing assertions rely on it) and now appends `budget.exceeded`
  (`run_token_limit_reached`) before it.
- **`run-processor.ts` was not edited.** Its comment says the loop writes `run.limit_reached`; it still does for the token
  limit. The money stop writes `run.stopped` itself and returns `end: "limit_reached"`, the same end the processor
  already handles for the other limits (the run is marked failed).
- **Prices are placeholders.** The table values are conservative, not a verified price list. The owner should review
  `MODEL_PRICES` (flagged in `docs/features/budgets.md` and the PR).
- **No UI to set the workspace monthly budget** (not in the AC): an owner-set `cost_budget_cents` on the workspace row is
  honoured and clamped to the 100,000-cent cap, but there is no screen for it yet.
- **Max tokens per run is optional in the AGO-89 edit draft (`AgentDraftText.maxTokens?`).** The edit form does not show
  the field, so an edit leaves the stored override alone (`run_limits` has no column grant for owners). This keeps the
  AGO-89 tests unchanged. Showing the field on the edit form is a follow-up.
- **Duplicate does not copy the run token limit.** `duplicate_agent` runs as the caller and `run_limits` is not copied
  (AGO-166 migration comment), so a copy starts with the worker default. The owner must set the limit again.

## Follow-up tasks
Dashboard (AGO-56), alerts and forecast (AGO-177), run view budget display (AGO-153). A screen for the workspace monthly
budget. Replace the static price table with a verified source.

## Outcome
(pending)
