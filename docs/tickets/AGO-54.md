# AGO-54 - US-044 Render approval cards on the server with consequence summary first

- Ticket: https://stratyge.atlassian.net/browse/AGO-54 (Story, Epic EP-16, wave 2, WS-E)
- PRs: (pending)
- Status: In progress
- Blocked by: AGO-37 (inbox and card, Done), AGO-47 (payload-hash binding, Done). Related: AGO-58 (the one decide path), AGO-215 (store the approval payload: migration plus worker, wave 3, not built)
- Risk: **high** (a human decision UI: the integrity of what the owner approves)

## Overview
"As the product owner, I want: render approval cards on the server with consequence summary first. Build cards from structured data, never from agent text, showing the consequence before the command and the full payload."

Acceptance criteria (verbatim):
1. The card renders from the stored payload, not agent prose
2. Long payloads cannot push the effect out of view
3. Consequence summary appears first
4. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## What exists today (explored 2026-11-17)
- `approvals` stores `action` (tool name only) and `payload_hash`. The payload itself is NOT stored (AGO-37 deferred it; AGO-215 adds it, a migration plus a worker change).
- Stored run events are hashes, counts and codes only: `tool_call.requested {tool_name, tier, input_hash}`, `policy.decision {decision, tier, reason_code, rule_id}`, `approval.requested {approval_id, call_id, payload_hash, tier, expires_at}`. No call arguments anywhere.
- AGO-37's `buildApprovalCards` (pure) turns those into `ApprovalCardData`; `ApprovalCard` (presentational, client) shows a header, a "Why it stopped / Tool / Call details / Cost" list, recent steps, a note that the owner cannot see the call, then Approve / Reject / Edit (disabled) / Ask (disabled). `ApprovalInbox` (client) polls with `router.refresh()` every second and owns the decide call (AGO-58 route).
- The card today puts the reason, a "Call details: not shown yet" line and the hash above the steps, and the buttons last. No consequence summary.

## The gap and how this ticket closes it
AC1 says "from the stored payload". Today only the structured fields above are stored. Without a migration (not mine to write: AGO-84 holds the schema slot, AGO-215 owns it) the card can be built honestly from those fields, and it must never fall back to agent prose.

Proposed build (pending the owner's answer to Q2):
1. **`ApprovalPayloadSource`**, a typed, discriminated source on `ApprovalCardData.payload`: `{ kind: "unavailable" }` today (the only value anything produces) or `{ kind: "stored", tool, args }` (validated by a Zod schema: a bounded record of JSON values). AGO-215 fills the second variant in `inbox-data.ts`; nothing else changes. Until then the card states, in the payload region, that the call details are not stored and shows the hash as a reference (as AGO-37 does).
2. **`summarizeConsequence(tool, tier, payload)`**, a pure, deterministic helper. Input: tool name, tier, optional structured args. Output: `{ headline, detail[], tierLabel, severity }`. A table keyed by tool name gives a verb phrase ("sends a message", "writes to your vault"); an unknown tool gets a generic sentence built from the tier ("runs <tool>, a Tier 3 action: it can change things outside the workspace"). Arguments, when present, are named by field (the recipient, the path), never interpolated from free text. Every string is plain text. The summary lives in `features/approvals` (not the shared barrel: nothing else uses it yet, so no contention with AGO-124).
3. **Card order**: (1) header (agent, waiting, time left), (2) **consequence summary** (first, always visible), (3) the decision buttons, (4) the call details region, bounded (`max-h`, `overflow-auto`, tabindex so keyboard users can scroll it), (5) why it stopped, cost, recent steps, (6) any agent-supplied text, if there ever is some, clearly labelled "Agent's own words (not checked)" as escaped text below the consequence. Today there is none.
4. **Long payload cannot hide the effect**: the payload region is bounded and scrolls inside the card, and the consequence and buttons sit above it in the DOM and stay in the first screen. Proven by a unit test (order, bounded region) and the device walk (a long reference or a very long tool name, screenshot).
5. **Decide path unchanged**: Approve / Reject still go through `ApprovalInbox` to the AGO-58 route; Edit and Ask stay disabled. No new route, no write.
6. **No `dangerouslySetInnerHTML`**; a test scans the approvals feature for it.

## Open design fork: where is "server" (Q3)
The inbox is a client component (it polls via `router.refresh` and owns decision state), so cards are rendered by the client from props the server computed. Option A (recommended): the consequence summary and the payload view are built on the server inside `buildApprovalCards` (pure, deterministic, from stored fields only) and sent as serialized, already-final data, so the client renders text it did not derive. Option B: restructure so each card is a server component streamed into the client inbox as a slot. B is a larger rewrite of AGO-37's polling and receipt logic and raises regression risk for the 1.5 s decision lock.

## Boundaries
- **Always:** derive from stored structured fields; render as React text; keep the decide path single; workspace-scoped reads.
- **Ask first:** any migration (AGO-215), changes to the decide route, new dependencies.
- **Never:** render agent prose as the consequence, `dangerouslySetInnerHTML`, a second card component, an agent-callable decide path.

## API changes
None. Database changes: none. Dependencies: AGO-37, AGO-47 (done); AGO-215 fills the payload variant later.

## Known limitations
The full call payload is not shown until AGO-215 stores it; the consequence summary then covers tool, tier and reason only, and says so. The payload source is wired and tested with a stored-payload fixture, but nothing in production produces it yet.

## Decisions
| # | Decision | Who / when |
|---|---|---|
| Q1 | A: record accepted | Jocarl Basco via standing rule, 2026-11-17 |
| Q2 | A: build from today's structured fields (tool, tier, reason code); payload section reads a typed source AGO-215 fills; full payload deferred to AGO-215 (follow-up) | Jocarl Basco via standing rule, 2026-11-17 |
| Q3 | A: consequence and payload view computed on the server in `buildApprovalCards`, final data passed to the existing client inbox; AGO-37 polling and decision lock kept | Jocarl Basco via standing rule, 2026-11-17 |

## Testing notes
Unit: `summarizeConsequence` (known tool, unknown tool, tier labels, args present, hostile strings stay inert), card order and bounded payload region, no agent prose path, no `dangerouslySetInnerHTML`. Existing AGO-37 acceptance tests keep passing. Device walk: a card with a very long tool name and reference; consequence and buttons stay in view.

## Follow-up tasks
AGO-215 (store the payload; fills `ApprovalPayloadSource`), Edit and Ask backends.

## Outcome
(filled at merge)
