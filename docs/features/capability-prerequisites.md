# Capability prerequisites

Three risky capabilities stay off until four safety checks pass, and a capability that is on is denied the moment its checks start failing.
Tickets: [AGO-85](../tickets/AGO-85.md). Builds on the [sandbox](sandbox.md), the [egress proxy](egress-proxy.md), the [credential broker](credentials.md) and [approvals](approvals.md).

## What is gated
| Capability | Needs |
|---|---|
| `code.run` | sandbox hardened, credential broker, approvals bound to the payload hash |
| `web.browse` | sandbox hardened, egress default deny, credential broker, approvals bound to the payload hash |
| `message.send_outbound` | egress default deny, credential broker, approvals bound to the payload hash |

The four checks are `sandbox_hardened`, `egress_default_deny`, `credential_broker` and `approval_payload_hash`. Each reports `pass`, `fail`, `error`, `timeout` or `not_run`, plus a fixed short reason code. **Only `pass` counts.** An error, a timeout, a missing report or a report that does not match the expected shape is a failure.

## Where the check runs
1. **In CI.** `apps/worker/src/prerequisites/prerequisites.test.ts` runs the real probes and requires all four to pass, then breaks each one on purpose and requires the right check, by name, to fail. It is part of the normal `test` job; no workflow change.
2. **At enable time.** The `enableCapabilityAction` server action (people only, owners only, workspace scoped) asks the worker for a fresh report and refuses to turn a gated capability on while any needed check fails. The refusal lists the failing checks. The form sends two ids and nothing else, so there is no client "it passed" flag to trust.
3. **At tool-call time.** In the worker, `createPrerequisiteGatedPolicyHook` wraps the policy hook. A gated capability whose checks fail, throw or time out is denied with `prerequisite_failed`, even if its `enabled` flag is true (the seed default is true). The gate only ever adds a deny; allows and approvals still come from the policy engine. Results are cached for 10 seconds.

4. **In the database.** `public.enable_capability()` is the only way to turn a capability on through the API (`capabilities.enabled` is no longer updatable by owners or `service_role`). It is owner only and refuses an agent credential (no signed-in user, no member). For a gated key it reads `capability_prerequisite_status`, which the worker rewrites for every workspace on start and every 30 seconds, and refuses unless each required check is `pass` and was recorded in the last 60 seconds. A missing, failing, errored, timed out, not-run or stale row is a refusal. `disable_capability()` turns one off with no check. A Vitest drift test keeps the database's key-to-checks map equal to the shared registry.

## How the web app gets the report
The worker's health server answers `GET /prerequisites` for loopback callers only. It runs the probes and returns `{ "results": [{ "name", "status", "reason"? }] }`: names, statuses and fixed reason codes, never paths, hosts, environment values or stack traces. Any failure is a bare `500 {"error":"unavailable"}`; any other method, path or non-loopback caller is a 404. The web app reads it from `WORKER_INTERNAL_URL` ([owner guide](../actions/set-worker-internal-url.md)), waits at most 2 seconds, validates the body with a strict schema and treats an unset variable, a down worker, a slow answer or a malformed body as "no report", which fails every check.

## What the probes check
Real behaviour built from the production code, no Docker needed:
- **Sandbox:** the `docker run` arguments the runner builds have no network, a read-only root, all capabilities dropped, no-new-privileges, the pinned image, resource limits, no mounts and no environment leaks.
- **Egress:** an unset, unreadable, malformed or wildcard allowlist yields deny all; the proxy arguments are hardened.
- **Broker:** a pasted raw key is refused and a missing credential is denied.
- **Approvals:** the payload hash is canonical and changes when the input or the tool changes.

## `run_code` and egress
`run_code` now gets its egress from worker code only: the allowlist file named by `EGRESS_ALLOWLIST_FILE` is read per run (unset, unreadable or invalid means no egress), and `SandboxRequest.egress` is never part of the model's tool arguments (a test proves a model-supplied `egress` never reaches the runner). Proxy decisions go to the structured log, blocks capped per run with one summary line when a run goes over. The `runtime_unavailable` message is a fixed sentence; the proxy's stderr never reaches the model.

## Known limits
- The direct update of `capabilities.enabled` through the API is closed by the migration. The table owner and superusers (infrastructure access) can still write the column; the tool-call gate still denies a risky capability whose checks fail even then. The worker's database role must be allowed to write `capability_prerequisite_status` (the local `postgres` role and `service_role` are). If the worker is down, the attestation goes stale after 60 seconds and enabling is refused.
- Probes check code and configuration invariants, not a live Docker daemon (Docker-in-CI is AGO-238). Results are stored only as the latest status per check (for the database function), not as history.
- Only enabling is gated here. Turning a capability off is never blocked.
