# AGO-84 - US-046 Implement the kill switch and drill

## Links
- Ticket: https://stratyge.atlassian.net/browse/AGO-84
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/74
- Related: AGO-86 (pause/resume/stop, merged), AGO-148 (credentials, merged), AGO-58 (human-only guard, merged), AGO-40 (budget hard stops), AGO-99 (holds the schema slot), AGO-139 (incident view, blocked by this)

Status: In review (round 3, migration round built). Type: Feature. Risk: high (human control, credentials, agent loop, auth, migration). Epic EP-06, wave 2.

## Overview
As an owner I want a kill switch that revokes credentials and preserves state so that I can contain an agent fast. AGO-86 gave a human-only stop for one run. The kill switch is the workspace-wide (or one-agent) version: one human action stops every live run in scope, revokes every credential in scope, keeps the scope latched so nothing new starts, and leaves all state readable for review. A drill test proves it, and runs in CI.

## Acceptance criteria (verbatim from Jira)
- [ ] Given the kill switch, when used, then all credentials for the scope are revoked and runs halt
- [ ] State is preserved for review
- [ ] A drill test runs in CI
- [ ] Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Note: the brief's carried-over AC (control flag before every tool call, agent tokens rejected, pause within one boundary) are AGO-86's and already shipped; this ticket reuses them and proves the kill path with them.

## Findings from exploration
- Stop exists per run: `request_run_control(workspace, run, 'stop')` sets `stop_requested_at` in `private.run_checkpoints`; the loop reads it before every tool call; the sweep (`run-control-sweep.ts`) finalizes runs with no loop (`run-stop.ts`).
- Credentials are already revoked by a DB trigger when a run leaves queued/running (AGO-148), and `agent_credentials.revoked_at` can be set once. So halting every run revokes their credentials.
- Nothing latches a scope: after a stop, a new run or credential could be issued at once. A kill switch needs that latch.
- `run_events` and `run_checkpoints` are runtime-only; the web app cannot write them. State preservation means: no deletes, checkpoints and events kept, a `run.stopped` event with reason `kill_switch` per halted run.

## Design (proposed)
1. **Scope:** `workspace` (all runs and credentials) or `agent` (one agent). Default UI is workspace.
2. **Route** `POST /api/control/kill` (thin), body `{ workspace_id, scope: "workspace" | "agent", agent_id? }`. Order as AGO-86: agent credential refused (403 plus event, reusing the AGO-58 guard, rejection function widened for this path), Zod, signed-in owner check, one RPC call.
3. **Recording:** one `SECURITY DEFINER` function `public.activate_kill_switch(...)`, human-only, owner-only, writes a latch row, sets `stop_requested_at` for every queued/running/paused run in scope and revokes live credentials in scope. It writes no run_events (runtime-only).
4. **Worker:** the existing control sweep finalizes the stops (reuses `finalizeStop`, which closes approvals as denied). The loop's existing control check halts running loops at the next tool-call boundary. Credential issuance and run start refuse while the latch is set (fail closed).
5. **Preserved state:** nothing is deleted or rewritten. Runs end `stopped`; checkpoints, events, notes and approvals stay readable.
6. **Release:** clearing the latch is a separate human, owner-only action (DB function and route). Stopped runs stay stopped.
7. **UI:** a kill button with confirmation in `apps/web/src/features/control` (owner only).
8. **Drill:** a repeatable test that starts N fake runs (fake model, no real calls), activates the kill switch, and asserts: every run ends `stopped`, every credential revoked, no tool call starts after the kill, new issuance refused, state intact. Runs in CI under `pnpm test` (in-memory fakes), plus a live-DB drill under the db lock locally.

## Database changes (SCOPE question: needs the schema slot, held by AGO-99)
One migration `<timestamp>_ago_84_kill_switch.sql` with a down script:
- `private.kill_switches (workspace_id, scope, agent_id null, activated_at, activated_by, released_at null)`, no API grants.
- `public.activate_kill_switch(p_workspace_id, p_scope, p_agent_id)` and `public.release_kill_switch(...)`, definer, `search_path` pinned, `authenticated` only, human session and owner role required.
- Widen `record_agent_approval_rejection` for the kill route (as AGO-86 did).
- Latch check in the credential issue trigger (reject while a switch is active for the workspace or agent).
- pgTAP for role, scope and workspace isolation, only under the db lock.

## Decisions
| # | Decision | Who | When |
|---|---|---|---|
| D1 | Record accepted; scope is workspace plus single agent | owner (Jocarl Basco) via orchestrator | 2026-11-16 |
| D2 | Wait for the schema slot (AGO-99 merges first). Build everything that needs no migration now; the migration is drafted below and is NOT under `supabase/migrations/` until the owner says the slot is ours | owner via orchestrator | 2026-11-16 |
| D3 | Use the real Jira AC (revoke credentials and halt runs, state preserved, drill in CI); the AGO-86 AC in the brief were a copy error | owner via orchestrator | 2026-11-16 |
| D4 | The latch is read in `readRunControl` (same read as pause/stop) and in the credential issuer; the pg guard is wired in `wire.ts` in the migration round (round 3), now that the table exists | worker | 2026-11-16 |
| D5 | Killed runs reuse the AGO-86 stop path and its `run.stopped` event (`stopped_by_human`); the latch row (who, when) is the kill audit | worker | 2026-11-16 |
| D6 | Audit reason for latch-caused stops stays `stopped_by_human` (checklist item 9). The stop is a human act, the flag path is identical to AGO-86, and the latch row (who, when, scope) is the kill audit. A distinct `kill_switch` reason would need a run-event schema change in `packages/shared`; offered as an optional follow-up for the owner, not done here | worker (migration round) | 2026-11-17 |
| D7 | The DB issuance latch is a separate trigger (`check_kill_switch_on_credential_issue`) instead of an edit to AGO-148's `check_agent_credential_issue`, so the merged function stays untouched and the down script is a clean drop | worker (migration round) | 2026-11-17 |

Owner decisions 2026-11-17 (Jocarl Basco, standing rule "go with recommendation always"): D6 is confirmed (latch-stop reason stays `stopped_by_human`); the three tester gaps (no release button, no latched state after reload, loop halt not exercised on the device lane) are accepted as non-blocking, with "follow-up: release button" and "follow-up: latched state on reload" as follow-up tickets.

Deviation (checklist item 5): `supabase/tests/rls_every_table_qa.test.sql` lists the public functions executable by `authenticated`; it now has twelve entries, adding `activate_kill_switch` and `release_kill_switch`. Both are definer functions guarded by a human-session and owner check.

## Migration (applied in round 3)
The draft that stood here is now the real migration: `supabase/migrations/20261117010001_ago_84_kill_switch.sql`, down script `supabase/rollbacks/20261117010001_ago_84_kill_switch.down.sql`, pgTAP `supabase/tests/kill_switch.test.sql`, rollback test `scripts/ago-84-rollback.test.mjs`. The original sketch is kept below for the design intent.

### Original sketch
```sql
create table private.kill_switches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  scope text not null check (scope in ('workspace', 'agent')),
  agent_id uuid references public.agents (id),
  activated_at timestamptz not null default now(),
  activated_by uuid not null,
  released_at timestamptz,
  released_by uuid,
  check ((scope = 'agent') = (agent_id is not null))
);
alter table private.kill_switches enable row level security;
-- deny-all for web roles: no policy and no grants for anon or authenticated (worker and definer functions only)
-- one live switch per scope
create unique index kill_switches_live_idx on private.kill_switches
  (workspace_id, scope, coalesce(agent_id, '00000000-0000-0000-0000-000000000000')) where released_at is null;
-- no grants for anon, authenticated or service_role (worker-only, like run_checkpoints)

-- public.activate_kill_switch(p_workspace_id uuid, p_scope text, p_agent_id uuid) returns jsonb
--   security definer, search_path = '', execute for authenticated only.
--   human session (auth.uid() not null, no agent_id/run_id/agent_credential claim) AND private.is_member(ws, 'owner');
--   scope 'agent' needs an agent in this workspace;
--   inserts the live latch (on conflict do nothing);
--   upserts private.run_checkpoints.stop_requested_at for every queued/running/paused run in scope;
--   sets revoked_at on every live agent_credentials row in scope (the existing trigger allows null -> timestamp only);
--   returns {runs_stopped, credentials_revoked}. Writes no run_events and never deletes.
-- public.release_kill_switch(...) same checks; sets released_at/released_by; returns zero counts. Never un-stops a run.
-- private.check_agent_credential_issue(): add a guard that raises 42501 while a live switch covers the workspace or agent.
-- record_agent_approval_rejection(): accept /api/control/kill and /api/control/kill/release (code control_route_rejected).
-- Down script: drop both functions, restore the two function bodies, drop the table.
```
pgTAP (under the db lock): owner only (member, anon, agent claim refused), workspace isolation, agent scope covers one agent, credentials revoked and none deleted, latch blocks issuance, release re-allows issuance and keeps runs stopped, RLS-every-table allow-list widened by two definer functions.

## What the drill proves (and what it does not)
The CI drill (`apps/worker/src/kill-switch/kill-switch.drill.test.ts`) runs the real agent loop, credential issuer and verifier, `finalizeStop` and `sweepControlRequests` over an in-memory office. Its `activate` is a hand-written copy of the SQL semantics, so it proves the **worker side** (how the loop, issuer and sweep react to a latch and a stop flag), **not the SQL**. That `activate_kill_switch` revokes the right rows is proved only by the live pgTAP drill in the migration round, so AC1 ("credentials revoked") needed the live pgTAP drill, which `supabase/tests/kill_switch.test.sql` now provides (the migration round). The merge condition (migration + guard wiring + live pgTAP drill passing) is checked in the Outcome below.

## Migration-round checklist (round 3 status; all items done in the same change as the migration unless noted)
Status: items 1-9 and 11 done (11 as a note only), 10 left as an optional follow-up. Item 1: the loop is wired in `wire.ts`. No production credential issuer exists yet (grep: `createCredentialIssuer` has no non-test call site), so there was nothing to wire there; whichever change first constructs it must pass `killSwitch: createPgKillSwitchGuard(pool)`. Item 4: done as the separate trigger in D7. Item 6: `KillSwitchControl` has no release button yet, only the release route; an owner release UI is a follow-up. Original wording follows.

1. Wire `createPgKillSwitchGuard(pool)` into `apps/worker/src/agent/wire.ts` (the loop's `killSwitch`) AND into the production credential issuer, in the same change as the migration. `createCredentialIssuer` (`apps/worker/src/identity/credential-service.ts:79`) has no production call site today (only tests build it): wherever the production issuer is first constructed, it must take `killSwitch: createPgKillSwitchGuard(pool)`; that change owns the wiring, and the migration round checks it with a grep for the call site. Not before: without the table the guard fails closed and would stop every run.
2. `enable row level security` on `private.kill_switches`, deny-all for web roles (in the draft above).
3. `activate_kill_switch` and `release_kill_switch` check `auth.uid()` is not null, no agent claims (agent_id, run_id, agent_credential) and the owner role.
4. DB-side issuance latch in `private.check_agent_credential_issue` (the TypeScript issuer check is only the first layer).
5. Down script under `supabase/rollbacks`, and widen the RLS-every-table allow-list in `supabase/tests/rls_every_table_qa.test.sql` (record as a deviation).
6. `pnpm db:types`, then drop the `as unknown as` RPC cast in `request-kill-switch.ts`.
7. Live pgTAP drill under the db lock (`acquire` / `supabase db reset` / `release`).
8. Mount `KillSwitchControl` on the owner page behind the owner check.
9. Decide the audit reason for latch-caused stops: today they record `stopped_by_human` (D5) and the kill appears only in the latch row; a reviewer reading run events will not see "kill switch". Product choice for the owner.
10. Optional: extract the route shell shared with AGO-86 (`NO_STORE`, `jsonError`, agent rejection, 401/403 mapping) into one helper.
11. Measure the latch read per tool call and per step once wired; do not cache it per run (a cache changes the fail-closed behaviour).

## Boundaries
- **Always:** workspace_id scoping with RLS, human-only (agent credential refused), owner role, fail closed, no deletes of state.
- **Ask first:** the migration, any change to the credential issue trigger.
- **Never:** let an agent activate or release the switch; delete run_events or checkpoints; call a real model.

## API changes
`POST /api/control/kill` and a release counterpart. Auth: signed-in workspace owner; agent credentials get 403.

## Known limitations
- A tool already running when the kill lands finishes (as AGO-86); nothing new starts.
- A running run whose worker died is finalized when the sweep or a retry reclaims it.
- No incident view (AGO-139).

## Testing notes
Unit with fakes (loop halt, sweep, issuance refusal), route tests (403 agent, 401, 403 non-owner, 400, 200), pgTAP and a live drill under the db lock. No real model calls.

## Follow-up tasks
- Incident view (AGO-139) reads the kill events.
- follow-up: release button. `KillSwitchControl` has no release button; release works only through `POST /api/control/kill/release`.
- follow-up: latched state on reload. The owner page shows no latched state after a reload (the latch itself persists and is enforced).
- Optional nits from round 3 review: focus is lost when the button swaps for the confirmation; the status text says "1 runs"; a Content-Type nit on the kill routes; `createCredentialIssuer` must take `killSwitch: createPgKillSwitchGuard(pool)` when it is first built.
- Not covered on the device lane: the worker loop halting a live run (covered by the in-memory drill and the live-DB tests).

## Outcome
Round 3 (2026-11-17), under the db lock after `supabase db reset` (local Docker stack only):
- Live pgTAP drill: `supabase test db` PASS, 30 files, 1052 tests; `kill_switch.test.sql` (48 assertions) ok. It proves owner-only (member, owner of another workspace, agent claim, no user and anon refused), workspace isolation, agent scope vs workspace scope counts, live credentials revoked and none deleted, runs flagged for stop, no `run_events` written, a repeat activation returns zero counts, the issuance latch blocks and (after release) allows, release never un-stops a run or un-revokes a credential, and the widened rejection event function.
- Rollback: `scripts/ago-84-rollback.test.mjs` with `RUN_DB_TESTS=1` (apply, roll back, re-apply, schema dump identical): 6 passed.
- `pnpm db:types`: the diff is only the two new functions. The `as unknown as` client cast in `request-kill-switch.ts` is gone and the call is fully typed: both functions declare `p_agent_id uuid default null`, so the generated type is optional and a workspace scope simply omits it. The mounted client component imports the schema from the new additive subpath `@ago/shared/kill-switch`, because the `@ago/shared` barrel pulls server-only env names into a client chunk and fails `pnpm build`.
- Wiring: `createPgKillSwitchGuard(pool)` is in the production loop (`wire.ts`). `KillSwitchControl` is mounted on the workspace home page for owners only. The routes now reach the real functions: owner gets 200, an agent credential gets 403 (the guard order is unchanged and covered by the route and handler tests).
- Open for the owner: D6 (the stop reason stays `stopped_by_human`), the missing release button, and wiring the guard into the production credential issuer when that issuer is first built.
