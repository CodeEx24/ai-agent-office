# AGO-99 - US-050 Start new agents in Strict with human promotion

- Ticket: https://stratyge.atlassian.net/browse/AGO-99 (Story, Epic EP-16, wave 2, WS-E, sprint 11)
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/73
- Blocked by: AGO-43 (autonomy dial, Done), AGO-89 (edit, duplicate, archive, Done). Related: AGO-58 (human-only guard), AGO-194 (pack import, builds on the default), AGO-192 (pack_events, precedent for a non-run audit table)
- Risk: **high** (autonomy, the human-only invariant, a migration)

## Overview
"As an owner, I want to promote an agent from Strict after reviewing its runs so that trust is earned."

Acceptance criteria (verbatim):
1. New agents default to Strict
2. Promotion is logged and human-only
3. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## What exists today (explored 2026-11-14)
- `agents.mode text not null default 'strict'` (AGO-74). `mode` is in no column grant, so no API caller can write it. Every creation path inserts without `mode`, so the column default already gives Strict: wizard (`create_agent` RPC, AGO-141), template create, `duplicate_agent` (AGO-89, copies no mode). Agent pack import is not built (AGO-194).
- Gap 1: nothing pins the default. `mode` is free text (AGO-43 left a CHECK as a follow-up), and no test asserts "every creation path lands in Strict".
- Gap 2: there is no way to change `mode` at all, so no promotion, no log, no human-only setter.
- `run_events` needs a `run_id`, so a promotion (not part of a run) cannot go there. Precedents for a workspace-level append-only audit: `pack_events` (AGO-192, written only by a SECURITY DEFINER function), `agent_versions` (AGO-89, trigger-written).
- Human-only: `requireHumanRequest` / `AgentCredentialRejectedError` (AGO-148, `apps/web/src/lib/auth/human-only.ts`); the agent actions in `features/agents/actions.ts` use `rejectAgentCredentialForEdit`. AGO-58 added the rejection event for approval routes.

## Implementation details (as built)
1. **Shared** (`packages/shared/src/agents/`, additive): `AGENT_MODES` (`strict`, `standard`, `relaxed`) and no second starting-mode constant: the database (column default plus insert guard) decides, and the existing `NEW_AGENT_MODE` in `agent-limits.ts` stays the one shared name for the value (round 2: the new `DEFAULT_AGENT_MODE` was removed because no creation path can read it, duplicate included); `setAgentModeSchema` (strict Zod: `agentId`, `mode`, no other keys); label and error copy.
2. **Database:** `supabase/migrations/20261115010001_ago_99_agent_mode_promotion.sql` + `supabase/rollbacks/20261115010001_ago_99_agent_mode_promotion.down.sql`:
   - `agents.mode` CHECK in (`strict`,`standard`,`relaxed`), after a guard that fails the migration if any row holds another value. Default stays `strict`.
   - `public.set_agent_mode(p_workspace_id, p_agent_id, p_mode)`: owner only, same style as the AGO-89 RPCs, refuses an archived agent, refuses a no-op, updates `mode`; the log trigger below writes the row in the same transaction. No grant on `agents.mode` itself.
   - Triggers on `agents` (both `ENABLE ALWAYS`): `agents_guard_mode_insert` makes a new row start in `strict`; `agents_log_mode_change` (`AFTER UPDATE OF mode`, `SECURITY DEFINER`) refuses any change of `mode` that is not made by a signed-in owner of the workspace (`auth.uid()` set, owner role) and writes the log row with that owner's member id. It does not depend on a session flag, so `service_role`, a worker connection and the table owner cannot change a mode without an owner and a log row. Limit: a role that can `ALTER TABLE ... DISABLE TRIGGER` can still turn the triggers off (infrastructure access). Changed in round 2 after the security review (the first design used a forgeable session flag).
   - The log (Q2). Append-only, no direct INSERT grant, UPDATE/DELETE/TRUNCATE blocked, workspace RLS, the actor pinned to the caller's own member id.
3. **Web** (`apps/web/src/features/agents/`): `promote-agent.ts` (logic behind an `AgentModeEditor` interface, testable without a DB), a server-only editor calling the RPC, `setAgentModeAction` in `actions.ts` (human-only check first, `parseInput`, owner check, revalidate), a small `AgentModeForm` on `/app/agents/[agentId]` (Q4).
4. **Human-only**: the action rejects an agent credential (the existing guard); an agent credential cannot reach the RPC because it has no `auth.uid()`. A rejected attempt returns the same error state as the other agent actions. An agent can never change its own mode.
5. **Duplicate** keeps resetting to Strict (a test pins it for a promoted source).
6. Docs: `docs/features/agents.md` (and an `autonomy.md` pointer), `docs/database.md` rows for the new objects.

## Decisions
| # | Decision | Who / when |
|---|---|---|
| Q1 | A, queued: one migration (mode CHECK, `set_agent_mode` RPC, the log). AGO-86 holds the schema slot, so the SQL stays a draft (`docs/tickets/AGO-99-migration-draft.sql`) and was held back until the slot was free (the orchestrator granted it 2026-11-15 after AGO-86 merged); it now sits under `supabase/migrations` with a timestamp after AGO-86's. Everything not needing the schema is built first | owner via orchestrator, 2026-11-14 |
| Q2 | A: new append-only `agent_mode_changes` table, written only by the RPC (no UPDATE/DELETE grants), workspace-scoped RLS, like `pack_events` | owner via orchestrator, 2026-11-14 |
| Q3 | A: any mode to any other, owner only, every change logged with from, to, who, when. The RPC rejects agent tokens and service callers acting for an agent | owner via orchestrator, 2026-11-14 |
| Q4 | A: owner-only form on `/app/agents/[agentId]` with a confirm step | owner via orchestrator, 2026-11-14 |
| Q5 | Record accepted (with Q1-Q4 as above) | owner via orchestrator, 2026-11-14 |
| D6 | Mode values reuse `POLICY_AGENT_MODES` (AGO-43); no new starting-mode constant (round 2: `DEFAULT_AGENT_MODE` removed, `NEW_AGENT_MODE` stays; the database default and insert guard are the source of truth) | worker |
| D7 | Server action only, no HTTP route (same as the AGO-89 actions). An agent credential gets the existing human-only error state; no rejection run event, because a web action has no run to attach it to (AGO-58's event is run-scoped) | worker; owner can overrule |
| D8 | Q4 promised a link to the agent's runs, but no runs route exists in the app. The form copy says "work" instead of "runs" and has no link; adding the link needs a runs view (follow-up) | worker, round 2 (UX review); owner can overrule |

## Boundaries
- **Always:** scope by `workspace_id`; owner role checked in the action and the RPC; Zod at the action; the log is append-only and written in the same transaction as the change; unknown mode means strict.
- **Ask first:** any change to Tier 3/4 behaviour; touching `scripts/`, approvals UI, control routes, agent-loop code.
- **Never:** let an agent credential change a mode; let a creation path or duplicate start in anything but Strict; write a mode from a client-supplied payload without the allow-list.

## API changes
No HTTP route. One server action (`setAgentModeAction`), human only, owner only. One RPC `set_agent_mode`.

## Database changes
One migration (see Implementation details, point 2): `agents_mode_check`, the guard triggers, table `agent_mode_changes` and function `set_agent_mode`. Rollback in `supabase/rollbacks/` (drops the log). pgTAP: `supabase/tests/agent_mode.test.sql`; the catalog tests and two fixtures (`agent_versions*.test.sql`, which inserted modes outside the new allow-list) were updated. Details in `docs/database.md`.

## Dependencies on other tickets
AGO-43 (modes; the policy engine reads `agents.mode`), AGO-89 (RPC, trigger and version patterns; duplicate), AGO-58 and AGO-148 (human-only), AGO-192 (audit table precedent), AGO-194 (pack import; lands agents in Strict through the database default).

## Known limitations
- No "review its runs" gate and no link to runs: the app has no runs view yet, so the form asks the owner to confirm they reviewed the agent's work (deviation D8) and does not require a review. (A runs link and a required-review rule are follow-ups.)
- The worker already reads `agents.mode` (AGO-43); no worker change here.

## Testing notes
Unit: shared schema and default; the action with and without an agent credential; duplicate of a promoted source. pgTAP (under the db lock, after `supabase db reset`): CHECK, owner-only, member/viewer/agent refused, log row per change, log immutable, cross-workspace isolation, every creation path (wizard RPC, duplicate) lands in strict.

## Follow-up tasks
- Pack import (AGO-194) must send no mode (the database lands it in Strict).
- Optional: require N reviewed runs before a promotion.
