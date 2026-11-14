# AGO-58 - US-045 Make approval routes human-only

- Ticket: https://stratyge.atlassian.net/browse/AGO-58 (Story, Epic EP-16, wave 2, WS-E, sprint 10)
- PRs: (pending)
- Blocked by: AGO-21 (approval request flow, done), AGO-148 (agent identity and credentials, done). Builds on AGO-47 (payload hash) and AGO-51 (static check).
- Related: unblocks AGO-140 (Reviewer lane), AGO-129 (red-team suite), AGO-163 (note-edit proposals). Must-fix carried over from AGO-21 (Jira comment 15493).
- Type: Feature - Risk: **high** (human-in-the-loop invariant, auth) - Status: In progress

## Overview
"As the product owner, I want: make approval routes human-only. Reject agent tokens on approval routes and treat Reviewer verdicts as advisory only."

Acceptance criteria (verbatim):
- An agent token calling an approval route gets 403 and an event
- A Reviewer approval does not satisfy a Tier 3 gate
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## What the code looks like today (from exploring)
- **There is no approval route yet.** `docs/features/approvals.md` says the decide route is AGO-58 and the inbox UI is AGO-37. So "make approval routes human-only" means: build the one human decide route (approve or deny) with the guard built in, and prove nothing else can decide.
- The human-only guard exists (AGO-148): `apps/web/src/lib/auth/human-only.ts` (`rejectAgentCredential` for route handlers and the proxy, `requireHumanRequest` / `isAgentCredentialRequest` for server actions). The proxy already answers **403** `agent_credential_not_allowed` to any request with an `ago_agt_` bearer, on every path (the allow-list is empty). It records **no event** and no log of who tried.
- Approvals are decided by a human through RLS: `approvals_update_member` lets a member move a pending, unexpired, unconsumed row to `approved` or `denied`, with `decided_by` = their own membership. No migration is needed for the decision itself.
- `run_events` is append-only and written only by the runtime (service role). The web app has no service-role client and no `run_events` write path. An event needs `workspace_id` and `run_id`; an agent credential carries both as signed claims (`verifyCredentialToken`, worker side, HS256 with `AGENT_CREDENTIAL_SIGNING_SECRET`).
- Agent loop gate: `resolveApproval` and `consume` only honour an `approved` row bound to the payload hash. There is no Reviewer lane yet (AGO-140), so no code path lets a Reviewer verdict touch an approval. That is the property to pin with a test.
- Static check `no-auto-approve.test.ts` lists human decision files in `HUMAN_DECISION_FILES` (empty): the new route goes there, with review.

## Scope
In:
1. **Decide route** `POST /api/approvals/[id]/decision` (body `{ workspace_id, decision: "approved" | "denied" }`, Zod). Order: agent-credential guard first (403 + event), then session (401), then the RLS update scoped by `workspace_id` and `id`, `status = 'pending'`. 404 when no row was changed (missing, other workspace, already decided, expired, consumed). Never takes or writes a payload hash: the approval stays bound to the hash it was created with. Listed in `HUMAN_DECISION_FILES`.
2. **Inventory of every approval-deciding entry point** (route handlers, server actions, SQL/RPC functions, worker paths), recorded in the feature guide and pinned by a test that fails when a new one appears without the guard: the decide route is the only web writer; the worker writes only `rejected` (expiry) and `consumed_at`; the only SQL that can set `approved` is the RLS-checked update by a signed-in member.
3. **403 plus an event for an agent token.** Event design is open question q1.
4. **Reviewer verdict is advisory.** Tests (worker, agent loop, fake store): a Reviewer APPROVE recorded for a Tier 3 call leaves the approval `pending` and the call unrun; a human `approved` row with a different payload hash still does not satisfy it; only a human decision bound to the hash (AGO-47) does. A shared constant/type names the Reviewer verdict as advisory so AGO-140 cannot wire it into the gate by accident.
5. **Timeout-wake race (must-fix carried from AGO-21)**, if the owner agrees (q2): make `resumeAfterApprovalExpiry` one atomic conditional update (wake only if still paused on that approval and no human pause request), with a race test.
6. Docs: `docs/features/approvals.md`, this record.

Out: the approvals inbox UI (AGO-37), the Reviewer lane (AGO-140), resuming a run after a human approves (separate run-control route), budget, agent-loop internals, packs.

## Design
- Guard: reuse `rejectAgentCredential` (no second pattern). The route calls it first; the proxy stays the outer layer.
- Event on agent rejection (proposal, q1-A): web verifies the token signature server-side (reusing the shared claims schema and the worker's `verifyCredentialToken` logic moved to or mirrored in `packages/shared`), and only a validly signed token produces an event (it names a real run and workspace). The token itself is never stored or echoed. Payload carries `agent_id`, the route and method, nothing else. A forged or malformed token still gets 403, with no event (no run to attach it to) and a log line.
- Decide route writes with the user's own session client (RLS), so no service role in web.

## Decisions
| # | Decision | Options | Choice | Who / when |
|---|---|---|---|---|
| 1 | Record ACCEPTED | A accept | A | owner, via orchestrator, 2026-11-14 |
| 2 | Where the agent-rejection event is written | A RPC migration - B worker job via pg-boss - C log only | A: web verifies the token signature, then calls one SECURITY DEFINER function (`set search_path = ''`, fixed event shape, no free-form payload, EXECUTE only to the narrowest role, revoked from public/anon, append-only, workspace-scoped). The migration is a LOCAL draft only: not pushed and not applied to the shared DB until the orchestrator sends `SCHEMA SLOT GRANTED` (after AGO-192 merges); then merge origin/main, use a timestamp later than every existing migration, push. pgTAP covers grants, append-only and a cross-workspace denial; rollback evidence (apply, down, shape check, re-apply) is recorded under the db lock. | owner, via orchestrator, 2026-11-14 |
| 3 | Fix the timeout-wake race in this ticket | A yes - B defer | A: atomic conditional update plus a race test (two concurrent wakes, exactly one transition); comment on AGO-21 that it is fixed in AGO-58. | owner, via orchestrator, 2026-11-14 |
| 4 | Reviewer verdict is advisory: proven with tests, no new Reviewer code (AGO-140 not built) | - | design | worker, 2026-11-14 |

## Boundaries
- **Always:** agent guard before session and before any write; scope by `workspace_id`; Zod at the boundary; never echo or store a token; 403 body fixed.
- **Ask first:** a migration (schema slot is held by AGO-192), a new web dependency, any scripts/ edit.
- **Never:** let the worker, loop, sweeper or a Reviewer write `approved`; take a payload hash from the caller; touch budget, agent-loop or pack code.

## API changes
`POST /api/approvals/[id]/decision`: 200 `{ id, status }`, 400 bad input, 401 signed out, 403 agent credential (fixed body `agent_credential_not_allowed`) or not a member, 404 not decidable.

## Database changes
None for the decision (RLS policy `approvals_update_member` already exists). One SECURITY DEFINER function, `record_agent_approval_rejection`, appends an `error.raised` event with the fixed code `approval_route_rejected` (owner decision q2-A). Deviation (2026-11-14): a new event type was tried first, but `scripts/ago-164-acceptance.test.mjs` pins the approved v1 list at 26 types, so adding one means amending that list and editing `scripts/` (human-merge path). Reusing `error.raised` avoids both; switching to a dedicated type later is a small change the owner can ask for. Migration `20261114130001_ago_58_agent_approval_rejection_event.sql` (rollback in `supabase/rollbacks`, pgTAP in `supabase/tests/agent_approval_rejection.test.sql`) was added after the orchestrator granted the schema slot (2026-11-14, after AGO-192 merged as e1bde15). SECURITY DEFINER, `search_path = ''`, EXECUTE for `service_role` only (revoked from public, anon, authenticated: the repo's RLS invariant pgTAP tests require it). Rollback evidence under the db lock: function count 1 before, 0 after the down script, 1 after re-apply (security definer, search_path empty, EXECUTE only service_role).

## Dependencies on other tickets
AGO-21, AGO-148 (done). AGO-47, AGO-51 (merged). AGO-192 holds the schema slot.

## Known limitations
- **The event needs `SUPABASE_SERVICE_ROLE_KEY` on the web server.** The function is executable by `service_role` only, so the recorder uses a server-only service client for this one call. If the key is not set, the recorder logs `no_service_key` (route and code only) and the 403 is still returned without an event. Deployment must set the key for the web server (server-only, never `NEXT_PUBLIC_`); it is already in the env schema.
- Design point resolved (2026-11-14): an earlier draft granted EXECUTE to `anon` because the web app had no service-role client. The repo's RLS invariant tests (`rls_catalog`, `rls_every_table_qa`: nothing executable by anon, authenticated limited to a fixed list) rejected that, and the owner asked for the narrowest grant, so it is `service_role` only. The function is still the bound (real credential tuple, fixed shape, flood cap).
- A forged or malformed agent token still gets the 403 but no event: it names no verifiable run, so it is logged only.
- The Reviewer lane (AGO-140) does not exist yet; the advisory rule is proven with the gate predicate and the worker loop, not with a real Reviewer.
- The AGO-51 scanner gaps (declare-default forms, out-of-scope roots) are recorded as follow-ups, not fixed, to keep `scripts/` out of this PR.

## Testing notes
`pnpm --filter @ago/web test` (route, recorder, inventory), `pnpm --filter @ago/worker test` (Reviewer advisory, wake race, `no-auto-approve`), `pnpm --filter @ago/shared test` (event table, decision schemas). pgTAP for the function (grants, append-only, cross-workspace denial) comes with the migration. Fake tokens and secrets are built at runtime. No model calls.

## Follow-up tasks
- AGO-37 builds the inbox UI on the decide route.
- AGO-140: Reviewer lane must keep its verdict advisory (test added here is the guard).
- AGO-51 scanner gaps (see docs/tickets/AGO-51.md Outcome): the remaining declare-default forms and the out-of-scope roots. Both are edits to `scripts/`-adjacent tooling, so they need their own ticket.
- Deployment: set `SUPABASE_SERVICE_ROLE_KEY` for the web server (needed for the audit event only).
- A Jira comment on AGO-21 that the timeout-wake race is fixed here.
