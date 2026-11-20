# AGO-85 - Gate risky capabilities on prerequisites

Status: In review (record accepted 2026-11-20)

## Links
- Ticket: [AGO-85](https://stratyge.atlassian.net/browse/AGO-85) (US-114), epic EP-17, wave 3
- PRs: [#92](https://github.com/CodeEx24/ai-agent-office/pull/92) (draft)
- Related: AGO-71 (sandbox), AGO-65 (egress proxy), AGO-157 (credential broker), AGO-47 (payload-hash approvals), AGO-125 (capability catalog), AGO-34 (policy engine), AGO-133 (unblocked by this), AGO-113 / AGO-81 (schema queue ahead of this), AGO-240/241/242/238 (egress follow-ups)

## Overview
Risk: high (security gate on tier 3 capabilities). Type: Feature.

Keep `code.run`, `web.browse` and `message.send_outbound` off until four prerequisites hold: the sandbox is present and hardened, the egress proxy is wired with default deny, the credential broker is in place, and approvals are bound to the payload hash. A check that fails, errors, times out or cannot run counts as failed (timeout means deny).

Acceptance criteria (verbatim):
- Capabilities cannot be enabled while any prerequisite check fails
- The check runs in CI and at enable time
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

Also carried from the ticket comment (AGO-65 notes): wire `createFileEgressAllowlistProvider` and `createEgressDecisionLogger`; keep `SandboxRequest.egress` out of model input (with a test); trim proxy stderr from the `runtime_unavailable` message `run_code` returns; aggregate or rate-limit blocked-request log lines.

## Findings from exploring the repo
- The catalog has `capabilities.enabled` (default **true**, seeded for every workspace). Owners may already `update (enabled, description)` through RLS from the API (AGO-125). There is no enable server action. So today an owner can flip `enabled` directly, with no check.
- The worker policy source already reads `capabilities.enabled` into each grant's `isEnabled`; the engine denies a disabled capability. No runtime prerequisite check exists.
- `run_code` is not wired to egress; nothing calls the allowlist provider or decision logger. Sandbox, egress, broker and approvals code are present, with no "is it really in place" probe.
- Risky starter keys: `code.run`, `web.browse`, `message.send_outbound` (tier 3). `integration.write` (tier 3), `payments.execute` and `data.delete_irreversible` (tier 4) are also tier 3+.

## Design (proposed, recommendations first)
1. **Pure registry (`packages/shared/src/capabilities/prerequisites/`)**: four named checks (`sandbox_hardened`, `egress_default_deny`, `credential_broker`, `approval_payload_hash`), a map of which risky capability needs which checks, and a pure evaluator. A result is `pass | fail | error | timeout`; only `pass` counts. Results carry the check name and a fixed reason code, never raw error text. Zod-validated.
2. **Runtime probes (`apps/worker/src/prerequisites/`)**: each probe checks real behaviour, not a flag: sandbox flags built by the runner (no network, read-only, cap-drop ALL, no-new-privileges, pinned image, no mounts/env); egress config (empty or invalid allowlist yields deny all; proxy args default deny; launcher fails closed); broker (a pasted raw key is refused; a missing credential is denied); approvals (a changed payload does not match the stored hash; expired or used approval refused). Each runs under a timeout and fails closed. Probes use the existing builders with fakes, no Docker needed.
3. **Where it runs**: (a) CI: a Vitest test in the existing `test` job that runs all probes and asserts they pass, plus negative tests that break each prerequisite and assert the evaluator fails by name (no workflow edit); (b) enable time: the web server action `enableCapability` (human only, owner role, agent tokens refused, workspace scoped) re-runs the checks server-side and refuses on any failure, returning failing check names; (c) tool-call time: a prerequisite gate around the policy hook (worker) denies a gated capability with reason `prerequisite_failed` when its checks fail, even if `enabled` is true. Short TTL cache; an error is a deny.
4. **UI**: the capability enable control shows disabled with the failing check name(s) and a plain reason; the action is the only enable path.
5. **Egress wiring**: `run_code` gets an `egress` option set only from worker code (allowlist provider by workspace), never from the model schema; `SandboxRequest.egress` is not in `inputSchema` or `modelInputSchema` (test: strict schema rejects it and tool arguments cannot reach the runner request). The `runtime_unavailable` message drops proxy stderr. `createEgressDecisionLogger` is wired with per-run aggregation of blocks.

## Open decisions (recommended answers first)
1. **Web vs worker probes.** Recommended: the shared pure checks run in the web action; worker probes are the authority at tool-call time; no schema. Alternative: worker stores a probe snapshot in a table (needs the schema slot).
2. **The direct-write hole.** Owners can already flip `capabilities.enabled` through the API grant, bypassing the action. Closing it needs a migration (revoke `update (enabled)`, enable via a security definer function). Recommended: do non-schema work first and ask the orchestrator for the slot (after AGO-81) for that migration; until then the tool-call-time gate (3c) denies a risky capability whose checks fail. Alternative: leave the grant and rely on 3c, with a follow-up ticket.
3. **Seed default** for the three risky keys stays `enabled = true`; the gate, not the flag, protects. Changing it is a migration.

## Boundaries
- **Always:** fail closed, workspace scoped, human-only enable, policy check stays first, no raw error text to the model or UI.
- **Ask first:** the migration (schema slot), any workflow edit.
- **Never:** let an agent enable a capability or change the checks; edit `.github/workflows/**`, `scripts/**`, the handoff module, runs or work features.

## Implementation details
- `packages/shared/src/capabilities/prerequisites/prerequisites.ts`: the registry, the strict result schema, `evaluatePrerequisites` and `describePrerequisiteFailures`.
- `apps/worker/src/prerequisites/`: `probes.ts` (four real probes), `run-prerequisites.ts` (5 s per probe, throw means `error`, slow means `timeout`), `prerequisite-gate.ts` (policy-hook wrapper, adds a deny only, 10 s cache), `egress-wiring.ts` (production `run_code` with the allowlist provider and the decision logger).
- `apps/worker/src/egress/egress-log-limiter.ts`: caps blocked-request log lines per run (20) and reports one summary on flush.
- `apps/worker/src/sandbox/run-code-tool.ts`: optional `egressFor` dependency; the `runtime_unavailable` message is a fixed sentence (no proxy stderr); neither input schema has an `egress` field.
- `apps/worker/src/server.ts` and `main.ts`: the loopback-only `GET /prerequisites` route, wired from `main.ts`. `agent/wire.ts`: the policy is wrapped in the gate and `run_code` is registered with its egress wiring.
- `apps/web/src/features/capabilities/`: `prerequisite-report.ts` (the fetcher), `enable-capability.ts` (the logic, behind `CapabilityEnabler`), `capability-enabler.ts` (the real owner-scoped reads and the one `enabled` update under RLS), `actions.ts` (the endpoint), `EnableCapabilityControl.tsx`, and the page `app/app/capabilities/page.tsx`.

## API changes
- Web: server action `enableCapabilityAction` (people only, owner role, workspace scoped; the form carries `workspaceId` and `capabilityId` only). Page `/app/capabilities`.
- Worker: `GET /prerequisites` on the health server. Loopback callers only, GET only, no side effects. Response `{results: [{name, status, reason?}]}`; names, statuses and fixed reason codes only. A failure is a bare `500 {"error":"unavailable"}`; anything else is a 404. The route does not exist when no provider is wired.
- Environment: **`WORKER_INTERNAL_URL`** (web server only, optional). Unset, invalid or unreachable means fail closed. Owner guide: [set-worker-internal-url](../actions/set-worker-internal-url.md). No `.env*` file was edited.

## Database changes
None in the first pass. A migration for decision 2 only after the schema slot is granted.

## Deviations
- The web app reads `WORKER_INTERNAL_URL` from `process.env` and validates it locally in `prerequisite-report.ts`, instead of adding it to the shared env schema (that file is outside this ticket's paths). Behaviour is the same: unset means fail closed.
- `apps/worker/src/main.ts` got a one-line additive edit (the `prerequisites` provider) beside the granted `agent/wire.ts` edit, because the health server is started there.
- There is no generator script or `docs/actions/README.md` in the repo, so the owner guide was added without regenerating a to-do list.

## Dependencies on other tickets
AGO-71, AGO-65, AGO-157, AGO-47 (done). Schema queue: AGO-81, then AGO-85. AGO-81 adds handoff rules in the policy area (additive only).

## Known limitations
**Direct-update gap (open until the schema slot):** an owner can still set `capabilities.enabled = true` through the API grant without going through `enableCapability`. The flag alone grants nothing: the tool-call-time gate denies a gated capability whose checks fail. The migration that revokes the grant is requested after AGO-81. Probes check code and config invariants, not a live Docker daemon (Docker-in-CI is AGO-238). Probe results are not stored.

## Testing notes
Vitest, no database. Shared: the evaluator (11 tests). Worker: the real probes pass (this is the CI check), each probe broken fails by name, throw and timeout mean fail, the gate denies (including through the real policy engine with a seeded enabled `code.run` grant), `egress` unreachable from model args, stderr trimmed, log cap, the `/prerequisites` endpoint (all pass, one failing, 500, GET only, loopback only, absent without a provider). Web: report fetcher (all pass, one failing, worker down, timeout, malformed or extra-field body, unset or invalid `WORKER_INTERNAL_URL`), enable logic (refused on a failing or missing report, non-owner, not found, write failure), action (agent credential refused, extra client fields rejected), enable control (disabled with the failing checks listed). Run: `pnpm --filter @ago/shared test`, `pnpm --filter worker test`, `pnpm --filter web test`, or `bash scripts/workflow/checks.sh`.

## Decisions
| # | Decision | Who | When |
|---|---|---|---|
| 1 | Record accepted as written. Web action runs the shared pure checks; worker probes are authoritative at tool-call time; no schema. | Owner (via orchestrator, standing rule) | 2026-11-20 |
| 2 | Non-schema work first; ask for the schema slot (queue: AGO-113, AGO-81, then this) for the migration that closes the direct `enabled` update. Until then the tool-call gate must provably deny an enabled risky capability whose checks fail. | Owner | 2026-11-20 |
| 3 | Seed default `enabled = true` stays. Add a test that a seeded enabled risky capability is still denied at call time when a check fails. | Owner | 2026-11-20 |

## Outcome
(empty until merge)
