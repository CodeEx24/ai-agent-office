# AGO-81 - US-113 Enforce agent-to-agent rules

Links
- Ticket: https://stratyge.atlassian.net/browse/AGO-81
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/91
- Related: AGO-148 (identity, done), AGO-34 (policy engine, done), AGO-160 (claims), AGO-188 (cross-department requests, unblocked by this), AGO-117 (Manager splits goals, follows this)
- Status: In review (draft PR 91). Spec accepted 2026-11-20; schema slot not yet granted (persistence follow-up)

## Overview
Handoffs are tasks. A sending agent creates a task for another agent; the receiver gets the smaller permission set and the original human requester's identity. Free-form agent chat does not exist. Epic EP-17, wave 3, risk **high** (authorization between agents).

Acceptance criteria (verbatim):
1. Free-form agent chat does not exist.
2. A handoff never grants more than the sender holds.
3. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done).

## Design
Everything is a pure, deterministic function plus a thin worker port, so the schema slot is only needed for persistence.

1. **`packages/shared/src/handoff/`** (new subpath export `@ago/shared/handoff`)
   - `handoffRequestSchema` (Zod, `.strict()`): `to_agent_id`, `title`, `description`, optional `requested` {capabilities, budget_cents, data_scope}. No `requester`, `approval`, `grants` or `workspace_id` fields: a forged one is rejected, not ignored.
   - `HandoffChain`: `{ requester_member_id, workspace_id, path: agent_id[], depth }`. Built only from the parent task; the requester is copied from the root task and never taken from agent input.
   - `narrowHandoff(sender, receiver, request)` returns the **effective permissions = intersection**: capabilities in both grants (and enabled); per-capability tier = max(sender, receiver); mode = `approval` if either is; budget = min(sender remaining, receiver, request); data scope = intersection of path prefixes; workspace must be identical. Never a union.
   - `checkChain(chain, to_agent)`: max depth `MAX_HANDOFF_DEPTH = 3`; a cycle (receiver already in path, or self-handoff) is refused.
   - Fixed reason codes (never free text), same style as the policy engine.
2. **`apps/worker/src/policy/handoff-rule.ts`** (additive, registered in the policy `index.ts`)
   - `evaluateHandoff(input)`: deterministic allow/deny. Denies: widening attempt (requested capability / tier / budget / scope the sender lacks), cross-workspace, requester mismatch, depth, cycle, archived or missing receiver. Tier 3/4 capabilities may be *listed* in the narrowed set but still escalate at call time through the normal engine; a handoff carries no approval and cannot pre-satisfy one.
   - `createHandoffScopedPolicySource(inner, store)`: wraps the existing `PolicySource` so that, for a run belonging to a handoff task, the receiver's grants are clamped to the stored narrowed set. The pure `evaluatePolicy` is **not** changed; the existing policy check before every tool call stays and now sees the clamped grants.
3. **`apps/worker/src/handoff/`**
   - `createHandoff({ store, sender, request, emitter })`: loads sender grants and the parent chain, runs the rule, writes **one task row** (the handoff) through a `HandoffStore` port, emits `handoff.created`. `acceptHandoff` emits `handoff.accepted`. The sender can never accept for the receiver.
   - `HandoffStore` port + in-memory implementation for tests. The Postgres implementation arrives with the schema slot.
   - A `handoff_task` tool (capability `tasks.handoff`, tier 1, human-granted, workspace-scoped) is the only way an agent starts a handoff; it goes through the policy hook like every tool.
4. **Requester identity on run_events**: the receiver's run events carry `on_behalf_of` (the requester member id) via the existing handoff events. Append-only; nothing updated.
5. **No free-form chat, proven twice** (`handoff-no-chat.guard.test.ts`): (a) scans `RUN_EVENT_SCHEMAS`, the worker tool registry and `apps/web` route files: fails if any event, tool or route lets an agent send arbitrary text to another agent outside a task row; (b) behavioural: the only text that reaches a receiver is the task title and description, delivered as untrusted data (existing untrusted-content boundary, AGO-23). Adding a "message", "chat", "dm" or "send_to_agent" tool or route fails the guard.
6. **Human-only routes**: no new route. The existing agent-token rejection (`hasAgentCredential`) is asserted in a test for the future handoff-management routes pattern; nothing is exposed to agent tokens.

## Decisions (recommended, awaiting owner)
| # | Question | Recommendation | Who / when |
|---|---|---|---|
| D1 | Tier of a capability in a handoff | max(sender, receiver): narrower wins | owner (via coordinator), 2026-11-20: accepted |
| D2 | Max chain depth | 3 (requester, A, B, C) | owner (via coordinator), 2026-11-20: accepted |
| D3 | Receiver's budget | min(sender remaining, receiver daily, request); the sender's spend is reserved, not shared | owner (via coordinator), 2026-11-20: accepted |
| D4 | Where the narrowing is enforced at run time | clamp via a wrapping `PolicySource`; `evaluatePolicy` stays untouched | owner (via coordinator), 2026-11-20: accepted |
| D5 | Persistence | needs a migration: `tasks` gets `parent_task_id`, `handoff_from_agent_id`, `requester_member_id`, `handoff_depth`, `handoff_grants jsonb` (narrowed snapshot); RLS unchanged (workspace scoped), agent writes only via a `SECURITY DEFINER` function for `service_role`. Request the schema slot after acceptance; build and test everything else against the in-memory store first | owner (via coordinator), 2026-11-20: accepted |
| D6 | Run events | extend `handoff.created` / `handoff.accepted` with optional `from_agent_id`, `task_id`, `on_behalf_of`, `depth` (additive, optional, `.strict()` kept). This edits `packages/shared/src/events/run-events.ts`, outside the listed owned paths: **SCOPE ask** | owner (via coordinator), 2026-11-20: accepted |
| D7 | Free text in `handoff.created.reason` | keep as the existing bounded field but forbid it from carrying task text: set to a fixed code in the handoff module | owner (via coordinator), 2026-11-20: accepted |

## Deviations (2026-11-20)
- The `handoff_task` tool reuses `tasks.manage` (tier 1) instead of a new `tasks.handoff` capability: a new catalog row needs a seed migration, which waits for the schema slot.
- The `handoff_task` tool is built and tested but not registered in the production tool registry, and the run loop does not yet call `createHandoffPolicyHook` / `acceptHandoff` (wiring in `apps/worker/src/agent/wire.ts` is outside the owned paths; follow-up).
- Design item 6 (agent-token rejection test) needs no new test: no route is added, and `hasAgentCredential` is already covered by AGO-148.
- The behavioural half of the no-chat proof checks that only the task row is written and a free-form field is refused. The untrusted-data wrapping of the task text at the receiver belongs to the context builder (AGO-23) and is not re-tested here.
- Persistence (D5) is NOT built: the owner has not granted the schema slot yet (ask again after PR 88 merges). The Postgres store, the `tasks` columns, the `SECURITY DEFINER` function and the pgTAP tests are follow-up work in this ticket once the slot is granted.

## Boundaries
- **Always:** scope by workspace_id; policy check before every tool call; Zod at the boundary; intersect, never union.
- **Ask first:** the migration (schema slot), the `run-events.ts` edit.
- **Never:** let an agent approve, carry or pre-satisfy an approval; accept its own handoff; rewrite the requester; edit or delete run_events; add any agent-to-agent text channel.

## API changes
None for humans. One new agent tool (`handoff_task`).

## Database changes
Deferred to the schema slot (D5). A rollback file will accompany it. None in the first commits.

## Dependencies on other tickets
AGO-148 (credential claims, read-only), AGO-34 (policy engine, read-only), AGO-160 (claims, read-only), AGO-164 (event schemas, D6).

## Known limitations
- Until the migration lands, handoffs persist only in the in-memory store.
- Data scope is modelled as path prefixes; richer scopes belong to AGO-188.

## Testing notes
Unit tests for every widening attempt (more capabilities, higher tier, bigger budget, wider data scope, another workspace, forged requester, depth, cycle, self-handoff, Tier 3/4 never auto-allowed); property-style test that the result is always a subset of both grants; the no-chat guard; `pnpm --filter @ago/shared test`, `pnpm --filter @ago/worker test`. DB-touching tests only under the db lock.

## Follow-up tasks
AGO-188 cross-department grants; web screen for a handoff chain; scheduled expiry of unaccepted handoffs.

## Outcome
(empty until merge)
