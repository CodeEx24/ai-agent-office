# AGO-34 - Build the deterministic policy engine

## Overview
Jira: [AGO-34](https://stratyge.atlassian.net/browse/AGO-34) (US-038), epic EP-06 (Control), wave 2 (Agent Runtime + Guardrails).
Risk tier: high (AI-safety surface: policy, approvals, human in the loop).

Evaluates `allow`, `deny` or `escalate` at the tool boundary, in code outside the model, with deny winning and tier
defaults applied. It replaces the deny-by-default stub that AGO-167 left behind the `PolicyHook` seam.
Blocked-by AGO-125 (capability catalog), AGO-167 (tool loop) and AGO-96 (layered `policies` table) are all Done.

Acceptance criteria and where they are proven:

| AC | Proof |
|---|---|
| Given a Tier 3 call, when evaluated, then the result is escalate | `policy-engine.test.ts` "AC1" (every mode, every level, even with an automatic grant and an explicit allow rule; the grant's tier wins over a tool that claims a lower one); `policy-engine-hook.test.ts` "AC1" (escalate maps to `needs_approval`); live test "applies tier defaults" |
| Given deny at any level, when evaluated, then the result is deny | `policy-engine.test.ts` "AC2" (each of the 4 levels x tiers 0-4 x both modes; a deny from one level is never loosened by an allow or require_approval from another) and the property test (2000 random inputs: adding a deny always yields deny); live tests "baseline deny" and "department deny wins over an agent allow" |
| Policy is loaded from the database, not from vault files | `createPgPolicySource` reads `policies`, `agent_capabilities`, `capabilities` and `agents` only, and nothing in the engine touches the vault or the filesystem; live test `policy-engine.integration.test.ts` (8 cases against the real tables, including an archived policy no longer applying and a malformed row failing closed) |
| Unit tests cover every tier and deny precedence | `policy-engine.test.ts`: table over tiers 0-4 x modes, a coverage check that the table has every tier and mode, deny placement at every level, wildcard and tool-name matching |
| Tests pass, no regressions, docs updated | `pnpm lint && pnpm typecheck && pnpm test`, this file |

## Implementation details
Pure evaluator, `packages/shared/src/policy/policy-engine.ts`: `evaluatePolicy({ call, agent, policies })` returns
`{ decision: allow | deny | escalate, reasonCode, ruleId? }`. It has no I/O, no clock and no model, and never throws.
Order, first match wins:

1. a stored policy failed to parse -> deny `policy_invalid`
2. no catalog capability and not a tier-0 built-in -> deny `no_capability`
3. no grant, or the capability is disabled -> deny `not_granted`
4. any `deny` rule at any level matches -> deny `deny_rule` (with `ruleId` = `<policy id>:<rule index>`)
5. effective tier (the higher of the tool's and the grant's) is 3 or 4 -> escalate `tier_requires_approval`
6. a `require_approval` rule matches -> escalate `rule_requires_approval`
7. the grant is in `approval` mode -> escalate `grant_requires_approval`
8. tier 2 in strict mode (or an unknown mode) -> escalate `strict_mode_tier2`
9. otherwise -> allow (`allowed_tier0|1|2`)

Rules match a capability key or a tool name: exact, `prefix.*`, or `*`. Layers are baseline < department < team < agent;
rules from all layers are collected and a deny anywhere wins, so a more specific layer can tighten but never loosen a
deny or a tier 3/4 escalate. `allow` rules never loosen anything in v1.

Worker, `apps/worker/src/policy/`:

- `pg-policy-source.ts` - `createPgPolicySource(db)` loads, per check and workspace-scoped, the agent's mode and
  department, its grants (joined to the catalog for tier and `enabled`) and the active baseline, department and agent
  policies. A missing agent throws; a grant with no catalog row counts as disabled; a row that fails
  `policyRuleSchema` is passed on as `rule: null`, which denies everything.
- `policy-engine-hook.ts` - `createPolicyEngineHook({ source })` is the real `PolicyHook`. `escalate` becomes
  `needs_approval`.

Changes to existing code:

- `agent/tools.ts` - `AgentTool.capabilityKey?` links a tool to its catalog capability. `agent/policy-hook.ts` -
  `PolicyToolCall.capabilityKey?`. `agent/agent-loop.ts` passes it through. No behaviour change for the loop.
- `agent/wire.ts` - production wiring now uses the engine hook instead of the deny-by-default stub.
- `packages/shared/src/index.ts` - exports the engine.

Guarantees kept from AGO-167 (all still enforced by the loop, which this ticket did not loosen): a hook that throws, times
out or answers malformed is a deny; `needs_approval` emits `approval.requested` with the sha256 `payload_hash` and the tool
never runs; tier 3 and 4 never run on `allow`; the loop emits `policy.decision` with the fixed reason code and a rule id,
never the arguments or secrets.

### Decisions taken (no human at the keyboard; recommended option picked)

| Decision | Chosen (recommended) | Why |
|---|---|---|
| Where the evaluator lives | `packages/shared` (pure), loader and hook in `apps/worker/src/policy` | Pure and dependency-free, so the web app can reuse it later (policy preview); the worker owns the database access. |
| Tool to capability link | Optional `capabilityKey` on `AgentTool`; no key means deny, except the tier-0 built-in `get_current_time` | Grants are by catalog key (AGO-141). A tool nobody granted must not run. Keeps the AGO-167 behaviour for the one built-in. |
| Agent modes | `strict` and `standard`; any other stored value is treated as `strict` | `agents.mode` is free text and only `strict` exists today (AGO-43 adds the autonomy dial). Unknown means the stricter answer. |
| `allow` rules | Accepted by the schema, never loosen anything | Deny always wins and humans stay in the loop; loosening needs its own decision. |
| Effective tier | Highest of the tool's, the grant's and the catalog's | A mislabelled tool or a stale grant cannot lower a tier. |
| Unparsable policy row | Deny everything for that agent (`policy_invalid`) | An unreadable deny rule must not be skipped. |
| Load policy per call | Read from the database on every check | An owner's change applies to the very next call; a few small indexed queries per tool call. |
| Team layer | Not loaded yet | There is no team membership on agents (AGO-108). The engine already orders `team` between `department` and `agent`. |
| Schema slot | No migration | Everything fits the existing tables (AGO-96, AGO-125, AGO-141). AGO-148 holds the slot. |

## API changes
None. Worker-internal.

## Database changes
None. No migration. Read-only queries against `agents`, `agent_capabilities`, `capabilities` and `policies`.

## Dependencies on other tickets
- AGO-167: the `PolicyHook` seam, the loop and its fail-closed handling.
- AGO-96: the `policies` table and `policyRuleSchema`.
- AGO-125: tiers and the catalog (`enabled`, `default_mode`).
- AGO-141: `agent_capabilities` grants and `mode`.
- AGO-148 (later): credential scope as an engine input. AGO-43 (later): the autonomy dial adds modes. AGO-108 (later):
  teams and departments tables. AGO-30 (later): resume after an approval.

## Known limitations
- Rules match the capability key or tool name only, not arguments (`argsSummary` is accepted by the call type for the
  audit trail and is not used for matching yet).
- `allow` rules are stored but have no effect; there is no way to loosen a default.
- Team policies are not loaded until agents can belong to a team.
- Only one built-in tool (`get_current_time`) exists, so only that tool is exempt from a grant.
- Credential scope (AGO-148) is not an input yet.
- Nothing in the app lets an owner author policies yet (the table and its RLS exist from AGO-96); rows are written by
  SQL or tests.
- No web or browser surface: the browser walkthrough does not apply. The live test exercises the real database path.
- No e2e run: `pnpm test:e2e` covers browser flows and this change has no web surface.

## Testing notes
`pnpm lint && pnpm typecheck && pnpm test`. Unit: `packages/shared/src/policy/policy-engine.test.ts` (table-driven over
tiers x modes x levels x deny placement, plus a deterministic property test) and
`apps/worker/src/policy/policy-engine-hook.test.ts`. Live: `apps/worker/src/policy/policy-engine.integration.test.ts`
(skips when the database is down). `pnpm test` runs it whenever the database is up, so run it inside the lock:
`node scripts/db-lock.mjs acquire AGO-34` ... `node scripts/db-lock.mjs release AGO-34`.
On a memory-tight machine the full parallel run can crash a Vitest worker (exit 134) or fail the multi-process
`ago-151-acceptance` case; each suite passes when run on its own.

## Follow-up tasks
- Policy authoring UI/API for owners (writes `policies`; human-only route).
- Team layer once AGO-108 lands; credential scope input (AGO-148); more modes with the autonomy dial (AGO-43).
- A loop-level integration test with real grants once vault tools register with `capabilityKey`.
