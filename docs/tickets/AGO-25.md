# AGO-25 - Filter ungranted tools from the model

## Overview
Jira: [AGO-25](https://stratyge.atlassian.net/browse/AGO-25) (US-036), epic EP-06 (Control), wave 2 (Agent Runtime + Guardrails).
Risk tier: high (AI-safety surface: tool access, policy, human in the loop).

The model is shown only the tools the agent is granted, so it cannot ask for an ungranted one. If it asks for a tool
that was not in the list anyway (unknown, renamed, revoked a moment ago), the call is rejected and logged and never
runs. This is an extra layer in front of the policy engine (AGO-34), not a replacement for it.
Blocked-by AGO-34 (policy engine) is Done. Builds on AGO-167 (tool loop), AGO-125 (catalog), AGO-141 (grants) and
AGO-148 (credential scope).

Acceptance criteria and where they are proven:

| AC | Proof |
|---|---|
| The tool list sent to the model contains only granted tools | `agent-loop.offer.test.ts` "tool list sent to the model" (exact list asserted on every model call; tier 3 offered only when granted; no grants means built-in only; mid-run revoke drops the tool from the next call; grants are looked up per step for this run's workspace and agent; an unreadable grant source fails the attempt before any model call); `tool-offer.test.ts` (offer rules); live test "AC1+AC2" and "withholds a tool whose capability the catalog has disabled" in `tool-offer.integration.test.ts` (real grants, other workspace's grant never offered) |
| A request for an unlisted tool is rejected and logged | `agent-loop.offer.test.ts` "a request for an unlisted tool": ungranted, unknown, renamed (case, padding), key-as-name and prototype names are each denied with `policy.decision` deny `tool_not_offered` + `tool_call.failed`, never executed, never reach the policy hook, no approval request, and no argument or secret in any event; live test asserts the same rows in `run_events` |
| Tests pass, no regressions, PR reviewed and merged, docs updated | `pnpm lint && pnpm typecheck && pnpm test`, this file |

## Implementation details
`apps/worker/src/agent/tool-offer.ts` is the single place that decides what the model sees.
`createToolOffer({ source })` returns `offeredToolNames(tools, scope)`: the names to show. A tool is offered when

- it names a catalog capability and that capability key is in the agent's granted set, or
- it is a built-in: no capability key, tier 0, on the built-in allowlist (`get_current_time`). This is the same rule
  the policy engine uses for `isBuiltin`.

Everything else is withheld, including a keyless tool that is not a built-in. A tool's name is never matched against
capability keys, and a built-in's name gives no free pass to a tool that claims a capability.

The granted set comes from `createPgGrantedCapabilitySource(createPgCredentialStore(pool))`: `agent_capabilities`
joined to `capabilities` where `enabled`, scoped by `workspace_id` and `agent_id`. That is exactly the set an agent
credential can carry (AGO-148 intersects with it at issue time and re-checks it live at verify time), so one query
serves both and the two cannot drift.

Loop changes, `agent/agent-loop.ts`:

- New required dependency `toolOffer`. Before **every** model call the loop asks it for the offered names and sends
  only those tool definitions. It is re-read each step, so a grant revoked mid-run (or a capability disabled in the
  catalog) drops the tool from the next model call.
- `executeToolCall` takes the step's offered set. A call whose name is not in it is denied with the fixed reason
  `tool_not_offered` (exported as `TOOL_NOT_OFFERED`) before the policy hook is consulted: `tool_call.requested`,
  `policy.decision` (deny, with the tool's tier, or 4 when unknown), `tool_call.failed`. Nothing runs. The events carry
  hashes and fixed codes only; the loop logs the call id and step, not the tool name or input.
- A tool that was offered still goes through the policy hook exactly as before, and a tier 3 or 4 tool that is offered
  (because it is granted) still stops for a human. Filtering only removes; it never allows.
- The hook-consulting code moved into a local `consultPolicy` function so the not-offered path can skip it. Its
  behaviour (timeouts, malformed answers, throws are denies) is unchanged.
- If the grant lookup throws, the attempt fails (and the queue may retry) with no model call. Showing a list nobody
  checked would defeat the purpose.

`agent/tools.ts`: `ToolRegistry.all()` lists the registered tools for the offer. `agent/wire.ts`: production wiring.
`agent/tool-offer.test-helpers.ts`: `offerAllTools`, used only by tests of the rest of the loop.

### Decisions taken (no human at the keyboard; recommended option picked)

| Decision | Chosen (recommended) | Why |
|---|---|---|
| Where the filter lives | One module, `agent/tool-offer.ts`, called by the loop before each model call | One place to audit; the loop already owns the model call, and nothing else can reach the provider. |
| Required vs optional loop dependency | Required `toolOffer` | An optional default of "offer everything" would silently fail open. Existing tests inject `offerAllTools`. |
| Source of the granted set | The credential store's grants-joined-to-enabled-catalog query | It is the credential scope (AGO-148) by construction, evaluated live, so a revoke or a disabled capability applies on the next call. No new SQL and no schema change. |
| Credential token in the loop | Not used yet | The loop does not hold a credential token today (issuing one per run is not wired). The credential's claims are an upper bound that the live set already bounds, so the live set is the effective scope. When the loop carries a token, a source can intersect it; the `GrantedCapabilitySource` seam takes it without changing the loop. |
| Unlisted call: hook or not | Deny before the hook, reason `tool_not_offered` | The model was never shown the tool, so this is not a policy question. The hook is not asked, and the reason is a fixed code with no arguments. |
| Same-step races | The step's offered set is what the model saw | A grant revoked between the model call and the tool call is still caught: the policy engine reads grants on every call. |
| Tier 3 and 4 tools | Offered only when granted | They escalate at call time as before; hiding them is only for the ungranted. |
| Keyless non-built-in tool | Not offered | Matches the engine, which denies a tool with no capability. |
| Grant lookup fails | Fail the attempt, no model call | Fail closed; the queue retry covers transient errors. |
| New run event type | None | `policy.decision` and `tool_call.failed` already carry what is needed; no shared-schema change. |
| Schema slot | No migration | Everything fits existing tables. AGO-166 holds the slot. |

## API changes
None. Worker-internal. New exports from `apps/worker/src/agent`: `createToolOffer`, `createPgGrantedCapabilitySource`,
`ToolOffer`, `GrantedCapabilitySource`, `ToolOfferScope`, `TOOL_NOT_OFFERED`; `AgentLoopDeps.toolOffer` is required.

## Database changes
None. No migration. One read-only query per model call against `agent_capabilities` and `capabilities`, scoped by
`workspace_id` and `agent_id`.

## Dependencies on other tickets
- AGO-34: the policy engine that still runs for every offered call.
- AGO-167: the tool loop and `ModelProvider` this filters in front of.
- AGO-125 / AGO-141: the catalog and the grants the offered set is made from.
- AGO-148: the credential scope the offered set equals.

## Known limitations
- One extra database read per model step (a small indexed query). Acceptable at the current run limits; a per-run
  cache would break the "revoke applies on the next call" guarantee.
- The credential token is not threaded through the loop yet (see the decision above).
- A tool whose registry entry has no `capabilityKey` is only ever offered if it is the tier 0 built-in.
- Team-level policy is not loaded yet (AGO-108); unaffected by this ticket.

## Testing notes
- Older AGO-167/AGO-166 tests that sent an unregistered tool name and expected the policy hook to see it now expect
  the earlier, fixed `tool_not_offered` deny with the hook never consulted (the registry also gained a read-only
  `all()`). Tests of the rest of the loop use `offerAllTools`. The live fixture grants use `mode = 'automatic'`.
- `pnpm --filter @ago/worker exec vitest run --maxWorkers=1 src/agent/tool-offer.test.ts src/agent/agent-loop.offer.test.ts`
  (no database).
- Live test, inside the db lock:
  `node scripts/db-lock.mjs acquire AGO-25`, then
  `pnpm --filter @ago/worker exec vitest run --maxWorkers=1 src/agent/tool-offer.integration.test.ts`, then
  `node scripts/db-lock.mjs release AGO-25`. It skips itself when the local stack is down.
- No real model call anywhere: a scripted fake provider asserts the exact tool list of each request.
- E2E in a browser does not apply: there is no UI surface; the worker has no HTTP surface for this.

## Follow-up tasks
- When the loop is given a per-run credential token (AGO-148 wiring), intersect its claims in the grant source.
- Consider a `tool.withheld` run event if operators need to see which tools were hidden from a run.
