# AGO-37 - Approvals inbox and card UI

- Ticket: https://stratyge.atlassian.net/browse/AGO-37 (US-039, Epic EP-06, Wave 2)
- PRs: (pending)
- Related: AGO-21 (request flow), AGO-47 (payload-hash binding), AGO-58 (human-only decide route), AGO-54 (later: consequence-first server rendering), AGO-86 (pause/resume/stop, parallel), AGO-40 (budgets, not merged)
- Type: Feature · Risk: high (human decision UI on approvals) · Status: spec awaiting acceptance

## Overview
One inbox where a signed-in member sees every pending approval in the workspace and decides it. As an owner, I want one inbox with approve, edit, reject and ask so that I can decide quickly.

Acceptance criteria (verbatim from Jira):
- [ ] Pending approvals list with age and agent
- [ ] Decisions update the run within 2 seconds
- [ ] Cards show payload, reason, recent steps and cost
- [ ] Tests pass, no regressions, PR reviewed and merged, docs updated

## Implementation details
Route `/app/approvals` (thin server component) -> `apps/web/src/features/approvals/` (list query, card components, client decision buttons, Realtime hook).
- **List:** pending, unexpired `approvals` rows of the active workspace (RLS select), joined to agent name; age shown from `created_at`, countdown from `expires_at`.
- **Card content** comes from stored structured data only, rendered as React text (never `dangerouslySetInnerHTML`, never HTML from agent text). Reason = `policy.decision.reason_code` + tier; recent steps = last N `run_events` of the run (type, step, tool name; counts and hashes only); cost = sum of the run's `budget.usage` events (`cost_micros`).
- **Decide:** every button calls the one existing path `POST /api/approvals/[id]/decision` (AGO-58, `decideApproval`). No second decision path. Agent tokens stay refused by the proxy and the route.
- **Freshness (2 s):** the open inbox re-reads every 1 s (see Deviations: not Realtime); a live test measures decision to inbox read and stored state.
- UI from `packages/ui` (Card, Button, Dialog, Table) and the AGO-115 tokens.

## Findings that shape the scope (from the code)
1. `public.approvals` stores `action` and `payload_hash` only; "the payload itself is never stored". No run event carries it either (events hold hashes). So "payload" cannot be shown today.
2. The decide route accepts only `approved` / `denied`. "Edit" (approve with changed input) would change the payload hash, so it is a new approval, not a decision. "Ask" has no backend at all.
3. A decision writes the `approvals` row only. Waking the paused run is a human run-resume in the worker (`createRunControl.resumeRun`), with no web route; control routes belong to AGO-86.

## Boundaries
- **Always:** scope by `workspace_id` under RLS; decide only through AGO-58's route; render agent text as inert text; validate input with Zod.
- **Ask first:** any migration (schema slot), any worker/agent-loop edit, new dependencies.
- **Never:** a second decision path; HTML from agent text; touching control routes, the autonomy dial or agent-loop code; real model calls.

## API changes
None planned (reuses `POST /api/approvals/[id]/decision`). A read-only data-layer function for the inbox list.

## Database changes
None planned. Showing the real payload needs one (see decision q1); not written until the schema slot is handed over.

## Dependencies on other tickets
AGO-21, AGO-115 (done); AGO-58 (merged a761f9d). AGO-54 builds on the same card later.

## Decisions
| # | Decision | Who / when |
|---|---|---|
| q1 | Payload on the card: C - ship the UI now with no schema change; the card shows what is stored (hash, tool, tier, reason, steps, cost). Full payload is a deferred AC | Owner (standing rule, recorded by the orchestrator), 2026-11-14 |
| q2 | Edit and Ask: A - Approve and Reject use the one AGO-58 decide path; Edit and Ask are shown disabled with a tooltip and listed as follow-ups | Owner, 2026-11-14 |
| q3 | "Within 2 seconds": A - inbox and run approval state update within 2 s via Realtime, proven by a test; the run wake stays with AGO-86 | Owner, 2026-11-14 |
| q4 | Record accepted | Owner, 2026-11-14 |

## Deviations
- **2026-11-14: polling, not Realtime.** The `approvals` and `run_events` tables are not in the `supabase_realtime` publication, so Realtime events would never arrive; adding them is a migration (not this ticket's slot). The inbox re-reads every 1 s (`INBOX_REFRESH_MS`) and shows a local decision's result at once. The ticket brief allows "Realtime or the existing run-update mechanism". Realtime stays a follow-up.
- A link to the inbox was added on the `/app` home page.

## Known limitations
- **Deferred AC: "full payload on the card".** The approvals table stores only a payload hash, so the card shows tool, tier, reason, hash, recent steps and cost. Follow-up: pending: store approval payload (migration + worker). The orchestrator proposes the ticket to the owner; this ticket does not create it.
- Edit and Ask are disabled with a tooltip (no backend). Follow-ups.
- A decision updates the approval and what the inbox and run show; waking the paused run stays with AGO-86.

## Testing notes
Unit (card rendering incl. hostile text, age formatting), component tests for the buttons, a route-level test that the inbox calls the decide route only, a 2 s latency test (decision to visible state change, local Supabase under the db lock), Playwright flow for the device tester. No real model calls.

## Follow-up tasks
- pending: store approval payload (migration + worker) so the card can show the full payload (deferred AC). The orchestrator proposes the ticket.
- Edit and Ask backends (they are disabled in the UI).
- Realtime for the inbox (publication migration), replacing polling.
- Waking the paused run after a decision (AGO-86).
