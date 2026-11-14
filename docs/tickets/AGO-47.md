# AGO-47 - Bind approvals to a payload hash, single-use and expiring (US-042)

## Links
- Ticket: https://stratyge.atlassian.net/browse/AGO-47
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/63
- Related: AGO-21 (approval request flow, done, blocker); AGO-74 (`approvals` table), AGO-107 (RLS); unblocks AGO-54 (server-rendered approval cards); AGO-58 (human-only decide routes) and AGO-37 (inbox UI) are separate

Status: Merged · Type: Feature · Risk: high (human-in-the-loop invariant: approvals bound to payload hash) · Wave 2

## Overview
After AGO-21 a call that needs approval gets a pending row and the run pauses, but an `approved` row is still closed `approval_not_granted`: nothing can ever run. This ticket makes a grant real, and only in the narrow case the AC describe. On resume, an `awaiting_approval` call runs only if its approval is `approved`, not expired, not consumed, and its stored `payload_hash` equals the hash of the exact payload about to run. The grant is consumed in one conditional update before the tool starts, so it is single use even with two workers racing. Every other case is a denial. Timeout still means deny; an agent still cannot approve (no code here writes `approved`).

## Acceptance criteria (verbatim)
- [ ] Given a changed payload, when executed, then the approval is rejected
- [ ] A used approval cannot be reused
- [ ] Approvals expire at their limit
- [ ] Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Carried over from AGO-21 (Jira comment): the approval id is derived from run, step and call id, so reject or disambiguate duplicate call ids within one step, with a test.

## Implementation details
1. **One hash helper** (`apps/worker/src/approvals/payload-hash.ts`): `approvalPayloadHash(toolName, input)` = SHA-256 of `canonicalJson({ tool_name, input })`. Moves the inline hash out of `agent-loop.ts` so the request side and the grant side cannot drift. `canonicalJson` moves with it (pure move, same output, covered by the existing hash tests).
2. **Atomic consume** (`ApprovalStore.consume`, pg impl in `approval-store.ts`): one statement, scoped by `workspace_id`:
   `update approvals set consumed_at = $now where workspace_id=$1 and id=$2 and run_id=$3 and status='approved' and consumed_at is null and expires_at > $now and payload_hash=$4 returning ...`.
   Zero rows = not granted. Two racers: exactly one gets the row. No migration: `consumed_at` and `payload_hash` already exist (AGO-74), and the worker connects as service role, which is not limited by the human-only UPDATE grant of AGO-107.
3. **Why a call was refused** (`resolveApproval` in `agent-loop.ts`): when `consume` returns nothing, read the row once and pick a specific error code for the model and the audit trail: `approval_payload_mismatch` (approved, hash differs), `approval_already_used` (consumed), `approval_expired` (approved or pending, past `expires_at`), `approval_denied`, otherwise `approval_not_granted`. All are denials; nothing runs.
4. **Grant path** (owner order, 2026-11-14: policy re-check, then atomic consume, then execute). `resolveApproval` only screens the row (approved, hash equals the one saved at request time) and returns `candidate`; it consumes nothing. The loop passes the approval to `executeToolCall`, which runs the full policy check first: a grant only satisfies `needs_approval`; a policy `deny`, an unregistered or not-offered tool, or invalid input stops the call with the approval untouched. Then, immediately before `beforeRun`, it recomputes the hash itself with `approvalPayloadHash(call.name, call.input)` (never a hash from the model or the payload) and calls `consume` with it. Only a returned row lets the tool run. Once consumed, the approval is spent even if the tool then fails. `tool_call.started` is persisted via `beforeRun` before the tool runs, as today, so a crash after consume never runs the call twice.
5. **Duplicate call ids in one step** (the index is part of the binding: an approval for call index 0 can never grant call index 1): when the loop builds the step's calls, a call id that repeats an earlier one in the same step is given the index-based id (`call_<step>_<index>`, made unique if that is taken too). Each call then has its own approval id and row. Test: two calls with the same id in one step get two distinct approval rows and cannot share a grant.
6. **Docs**: update `docs/features/approvals.md` (what runs, the refusal codes, single use, limits).

## Boundaries
- **Always:** scope by `workspace_id`; policy check before every tool call, also on a granted call; compare against the hash of the payload about to run, never trust a stored copy alone; consume before running; keep only the hash, never the payload; timeout means deny.
- **Ask first:** any migration (none planned), changes outside owned paths, new run event types.
- **Never:** let an agent or the loop write `approved` or `denied`; run a call because a row exists; edit `run_events`; build decide routes or UI (AGO-58, AGO-37).

## API changes
None (no HTTP route). New worker-internal seam: `ApprovalStore.consume`.

## Database changes
None. Uses `approvals.payload_hash`, `consumed_at`, `expires_at` as created in AGO-74. If a migration turns out to be needed it is a SCOPE question first (this ticket does not hold the schema slot).

## Dependencies on other tickets
AGO-21 (request flow, `resolveApproval`, expiry), AGO-74/AGO-107 (table, RLS), AGO-30 (checkpoint). Unblocks AGO-54. AGO-58 adds the human decide route that makes `approved` rows appear.

## Known limitations
- No decide path yet, so in production `approved` rows only appear once AGO-58 lands; the grant path is exercised by tests that write `approved` as a human would (through the test helper).
- The checkpoint stores a scrubbed copy of a call's input (AGO-30). A call whose input held something the scrubber changes will hash differently on resume and be refused (`approval_payload_mismatch`). That is fail closed by design; the human approved what they saw, not the scrubbed copy.
- An approved, unconsumed row past `expires_at` is refused on resume but keeps status `approved` (a human's decision is never rewritten by the worker); `consume` is what enforces the limit.
- A crash between `consume` and the `started` checkpoint leaves a spent approval and a call that is then denied on resume (`approval_already_used`). Safe, but the human has to approve again.

## Testing notes
Unit tests with fakes (no model calls). Integration tests against the local stack under the db lock (`node scripts/db-lock.mjs acquire AGO-47`, `supabase db reset` first, release promptly).
- Changed payload after approval: refused `approval_payload_mismatch`, tool not run, row not consumed.
- Used approval: second resume of the same call refused `approval_already_used`; the tool ran exactly once.
- Expiry: approved row past `expires_at` is refused `approval_expired`; pending past `expires_at` still denies (AGO-21).
- Race: two concurrent `consume` calls on one real row, exactly one wins (integration).
- Policy still wins: a granted call whose policy now denies does not run and the approval is not consumed.
- Hash helper: key order does not change the hash; any value, nested value or tool name change does.
- A failing tool after consume: approval stays consumed, a second attempt is refused.
- Index binding: approval for call index 0 never grants call index 1 (same call id in the model's answer).
- Not approved states (pending, denied, rejected), other workspace, other run, missing store: never run.
- Duplicate call ids in one step get separate approvals.
- Invariants: an agent-origin path cannot produce `approved` (the store has no method that writes it).

## Decisions
| # | Decision | By | When |
|---|---|---|---|
| 1 | Duplicate call ids in a step are disambiguated by index, not rejected; the model's run continues and each call gets its own approval | recommended option, per owner's standing rule (to confirm at record acceptance) | 2026-11-14 |
| 2 | No new run event type; refusal reason is the `error_code` on the existing `tool_call.failed` event | recommended option, per owner's standing rule (to confirm at record acceptance) | 2026-11-14 |
| 3 | No migration; the worker consumes with a conditional update on existing columns | brief (migrations not held by this ticket) | 2026-11-14 |
| 4 | Record accepted (AGO-47-q1, option A). Required checks: (1) hash computed by the worker from the canonical serialization of the exact tool name and arguments about to run, never trusted from the model; key-order change hashes the same, any value change mismatches (tested). (2) Order is policy re-check, atomic consume, execute; a consumed approval is never reusable even if the tool fails; two concurrent consumes yield exactly one winner (live DB race test). (3) The duplicate-id index is part of the binding; approval for index 0 never grants index 1 (tested) | owner (via coordinator, msg_a66dc1ef0726) | 2026-11-14 |

## Follow-up tasks
- AGO-58: the human-only decide route that writes `approved` / `denied` (decided_by from the session, never an agent token).
- Consider an `approval.consumed` run event if the audit trail needs it (would add an event type).

## Outcome
Status: Merged · Feature guide: docs/features/approvals.md
PR: https://github.com/CodeEx24/ai-agent-office/pull/63

- AC1 changed payload rejected: met (worker-computed canonical hash; the store refuses a mismatch, unit + live-DB tests).
- AC2 used approval not reusable: met (one conditional UPDATE consumes it; live two-worker race, exactly one runs).
- AC3 expires at its limit: met (boundary tests at exactly the limit and one millisecond before).
- AC4 tests, docs, review: met (worker 907/907; round 1 tester-functional, reviewer-code, reviewer-security and invariants all PASS; approver APPROVE).
- Rounds: 1. The round-1 gate was red only on the known scripts/ago-151-* pg-boss flake (AGO-212); the pre-merge re-gate on 0e8000b was fully green.
- Deviations: none from the accepted record.
- Follow-ups: AGO-58 (human-only decide route); optional approval.consumed run event; approver hardening note: compare expiry against least(worker clock, DB now()) in consume.
