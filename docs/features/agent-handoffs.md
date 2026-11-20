# Agent handoffs: agent-to-agent rules
Tickets: AGO-81 (created). Related: AGO-148 (agent identity), AGO-34 (policy engine), AGO-160 (claims), AGO-188 (cross-department requests, planned), AGO-117 (Manager splits goals, planned)

## What it does
Agents never chat. One agent gives work to another only by creating a **task** for it (a handoff). The receiving agent gets the **smaller** permission set, and the task keeps the identity of the **human who started the work**, so every run event in the chain says who it acts for. A human is still in the loop: a handoff carries no approval, and Tier 3 and 4 actions still need a person.

## Screens
None yet. A handoff is a worker feature; a chain view is a follow-up.

## Data model
Handoff state is a task row plus a stored chain (`HandoffRecord`): task id, sender, receiver, `requesterMemberId`, `path`, `depth`, the narrowed permissions, and the task title and description. Persistence is behind the `HandoffStore` port. The Postgres implementation (`pg-handoff-store.ts`) stores a handoff as a `tasks` row with extra handoff columns (parent, sender, requester, depth, path, narrowed grants, accepting run). Two database functions (`create_handoff_task`, `accept_handoff_task`, `service_role` only) are the only writers: they read the sender from the run, derive the requester and chain from the sender's own task, and refuse a narrowed set wider than what the sender holds. No handoff column is writable by an agent token or a person. The in-memory store in `handoff-store.test-helpers.ts` is test-only.

## Data flow
```mermaid
flowchart LR
  Model --> Tool["handoff_task tool"]
  Tool --> Policy["policy engine (tasks.manage, tier 1)"]
  Policy --> Create["createHandoff"]
  Create --> Rule["evaluateHandoff"]
  Rule --> Narrow["narrowHandoff + extendChain"]
  Create --> Store[("HandoffStore: one task row")]
  Create --> Event["run_events: handoff.created (on_behalf_of)"]
  Recv["Receiver run"] --> Clamp["createHandoffPolicyHook"]
  Clamp --> Engine["evaluatePolicy (unchanged)"]
```

## Rules
- **Intersection, never union.** Capabilities: only keys both agents hold, enabled on both sides. Tier: the higher of the two. Mode: `approval` if either is. Budget: the smallest of the sender's remaining budget, the receiver's and the request. Data scope: the overlap of the path-prefix lists.
- **Widening is refused, not trimmed.** Asking for a capability, budget or scope the sender does not hold is a denial (`widening_capability`, `widening_budget`, `widening_scope`).
- **The requester cannot be rewritten.** It comes from the stored chain (the root task's human creator). The request schema is strict: `requester_member_id`, `on_behalf_of`, `approval_id`, `tier`, `workspace_id` and any other extra field are rejected; a claimed requester that differs from the chain is `requester_mismatch`.
- **Chains are bounded.** Maximum depth 3 (`MAX_HANDOFF_DEPTH`); a cycle or a hand-off to yourself is refused. A run with no human requester cannot hand off (`no_requester`).
- **The policy check stays.** The receiver's run is checked by `evaluatePolicy` on every tool call; `createHandoffPolicyHook` only clamps its grants to the handoff's intersection first, so a capability the sender did not pass on is `not_granted`, even if the receiver holds it. Tier 3 and 4 still escalate.
- **Only the receiver accepts.** `acceptHandoff` refuses the sender or any other agent (`wrong_agent`) and a second accept (`already_accepted`).
- **Task text is data.** The only text that reaches the receiver is the task title and description, as untrusted data. The `handoff.created` event carries a fixed reason (`task_handoff`), never task text.
- **No free-form chat.** `handoff-no-chat.guard.test.ts` fails if a run event, a worker tool or a web route looks like agent-to-agent messaging, or if a handoff event gains a recipient or text field besides the fixed reason.

## Main functions and files
| function | file | role |
|---|---|---|
| `handoffRequestSchema`, `MAX_HANDOFF_DEPTH`, `HANDOFF_DENIAL_REASONS` | `packages/shared/src/handoff/handoff-schemas.ts` | Strict request, limits, fixed reason codes (`@ago/shared/handoff`) |
| `narrowHandoff`, `extendChain`, `intersectDataScopes` | `packages/shared/src/handoff/handoff-rules.ts` | Pure intersection and chain rules |
| `evaluateHandoff` | `apps/worker/src/policy/handoff-rule.ts` | The deterministic rule: allow with narrowed permissions, or deny with a code |
| `createHandoffPolicyHook`, `clampToHandoff` | `apps/worker/src/policy/handoff-policy-hook.ts` | Receiver runs inside the intersection |
| `createHandoff`, `acceptHandoff` | `apps/worker/src/handoff/create-handoff.ts` | Writes the task row, emits the events |
| `createHandoffTool` | `apps/worker/src/handoff/handoff-tool.ts` | The `handoff_task` agent tool (capability `tasks.manage`, tier 1) |
| `HandoffStore` | `apps/worker/src/handoff/handoff-store.ts` | Persistence port |
| `createHandoffWiring`, `createUnavailableHandoffStore` | `apps/worker/src/handoff/handoff-wiring.ts` | The policy hook and tool that `agent/wire.ts` registers; a fail-closed store for tests |
| `createPgHandoffStore` | `apps/worker/src/handoff/pg-handoff-store.ts` | Postgres store: reads parties and chains, writes only through the two functions |
| `create_handoff_task`, `accept_handoff_task` | `supabase/migrations/20261120020001_ago_81_agent_handoffs.sql` | The only writers of the handoff columns; re-check the rules in SQL |

## Run events
`handoff.created` and `handoff.accepted` gained optional `from_agent_id`, `task_id`, `on_behalf_of` and `depth` (set by the worker from the stored chain). Old events without them still parse.

## Known limits
- The production run loop is wired (`agent/wire.ts` uses `createHandoffPolicyHook` and registers `handoff_task`) with the Postgres store. Nothing starts the receiver's run for a handoff task yet, so the run loop does not call `acceptHandoff`; the queue follow-up does that. The clamp does not need that link: any run on the handoff task (`runs.task_id`) is clamped, and every hop must fit inside the parent handoff's grants and budget, not just the sender's own.
- The narrowed budget is a cap on the `budget.usage` cost of the runs on the task. It is checked before each model call (spend so far plus the call's worst case must fit, `handoff_budget_would_be_exceeded`, through the AGO-40 guard) and tool calls are denied once it is reached (`handoff_budget_exhausted`). A child handoff gets at most the parent's remaining budget. Two calls in flight on one task read settled spend, so both can pass. The database refuses a non-empty data scope and a requester who is no longer an active member.
- A party's data scope is empty (agents have no stored vault scope yet), so a handoff passes on no data scope until AGO-188 adds one. Budget is read at handoff time, not reserved against the sender.
- A dedicated `tasks.handoff` capability was not added (it needs a catalog seed); the tool reuses `tasks.manage`, so any agent allowed to manage tasks can start a handoff. The handoff rule bounds what it passes on.
- Data scope is a list of path prefixes; richer scopes belong to AGO-188.

## How to extend it
- New narrowing dimension: add it to `narrowHandoff` (take the stricter side), add a denial code, and add a widening test.
- New denial reason: add it to `HANDOFF_DENIAL_REASONS`, return it from the rule, add a test.
- Any new agent-to-agent path must be a task. Do not add a message or chat tool, event or route; the guard test will fail.
- Tests: `pnpm --filter @ago/shared exec vitest run src/handoff` and `pnpm --filter @ago/worker exec vitest run src/handoff`.
