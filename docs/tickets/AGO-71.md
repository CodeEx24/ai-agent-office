# AGO-71 - Build the per-run sandbox

## Links
- Ticket: [AGO-71](https://stratyge.atlassian.net/browse/AGO-71) (US-112), epic EP-17, wave 3
- PRs: [#79](https://github.com/CodeEx24/ai-agent-office/pull/79)
- Related: AGO-167 (tool loop, done), AGO-65 (egress proxy), AGO-85 (capability prerequisites), AGO-129 (red-team suite)

## Overview
Risk: high (isolation boundary for untrusted code). Type: Feature.

Code and file tools run in a throwaway Docker container with no network, no host sockets and hard CPU, memory, process and time limits. The sandbox runs only after the policy engine allowed the call (AGO-167 hook, unchanged); a limit breach is a typed, logged deny, never a hang. Timeout means deny.

Acceptance criteria (verbatim):
- Given a run, when code tools execute, then there is no network access and no host socket
- CPU, memory and time limits are enforced
- Escape probes in the test suite fail
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details
New module `apps/worker/src/sandbox/`:
- `sandbox-runner.ts` - `SandboxRunner` interface (`run(spec) -> SandboxResult`), limits type with safe defaults and hard bounds (clamped, never "unlimited"), typed result: `completed` (exit code, capped stdout/stderr, duration) or `denied` with a reason code (`timeout`, `out_of_memory`, `output_limit`, `runtime_unavailable`, `invalid_request`).
- `docker-runner.ts` - Docker implementation over the `docker` CLI via `child_process` (no new dependency). One container per call, always removed. Flags: `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, `--pids-limit`, `--memory` = `--memory-swap`, `--cpus`, no Docker socket and no host path mounts. Scratch space is a size-capped `tmpfs` at `/work`, so nothing touches the host disk. A wall-clock timer kills and removes the container.
- Files in: passed as a tar on stdin and unpacked into `/work` by the entrypoint wrapper (paths validated: relative, no `..`, size capped). Files out: stdout/stderr only in v1 (the tool loop returns text).
- `run-code-tool.ts` - `AgentTool` `run_code` (tier 3, capability `code.run`, already in the starter catalog), `execute` calls the runner and throws a typed error on a denied result so the loop emits `tool_call.failed`. Not added to the policy allowlist: it stays denied by default until AGO-34 grants it.
- `apps/worker/sandbox/Dockerfile` - pinned minimal image (Alpine, non-root user).
- Wiring: the tool is a registry entry; no changes to the loop or the policy order.

## Boundaries
- **Always:** policy check before the sandbox runs; clamp limits; remove the container on every path; scrub tool output (the loop already does).
- **Ask first:** CI changes (Docker-in-CI), any migration.
- **Never:** mount the Docker socket or a host path; give the container network; bypass or reorder the policy hook.

## API changes
None.

## Database changes
None.

## Dependencies on other tickets
AGO-167 (tool seam, policy hook). Unblocks AGO-65, AGO-85, AGO-129.

## Known limitations
- Needs Docker on the worker host. Without it the runner returns `denied: runtime_unavailable`; the Docker tests skip with a clear reason.
- Files out are not supported in v1 (text output only).
- Limits are runner options with safe defaults; wiring them to per-agent settings is a follow-up.
- Windows/WSL: Docker Desktop runs Linux containers, so isolation is the Linux kernel's; `--cpus` and `--memory` rely on WSL2 cgroups.

## Testing notes
Real-container tests (no mocks for AC1-AC3), skipped when Docker is unavailable, with file-level timeouts. Escape probes: DNS, raw TCP, HTTP to a host listener, `/var/run/docker.sock`, abstract unix sockets, setuid, mount, ptrace, write outside scratch, read host paths, fork bomb, memory blow-up, CPU spin, sleep past the limit. Each must fail to escape. Unit tests: flag construction, limit clamping, tar path validation, tool error mapping.

## Follow-up tasks
- Per-agent sandbox limits in settings; files-out channel; Docker-in-CI job (owner merges workflow changes).

## Decisions
| Decision | Who | When |
|---|---|---|
| Docker CLI, tmpfs scratch, stdin tar in, text out | Accepted as written (owner standing rule: recommendation) | 2026-11-17 |
| Add: base image pinned by digest; Docker default seccomp/AppArmor (never unconfined); `--ipc none`; `no-new-privileges`; ulimits nofile/nproc; `--init`; per-run container label, force-remove on every exit path with a test; stdout/stderr cap | Owner, via orchestrator | 2026-11-17 |
| Docker-in-CI is a follow-up the owner files at merge; skipped Docker tests print the reason | Owner | 2026-11-17 |

## Deviations
- No separate Dockerfile: the sandbox uses the digest-pinned `alpine:3.22` image directly (`SANDBOX_IMAGE`), nothing is built.
- Each run gets a random unprivileged uid (not a fixed `nobody`). `RLIMIT_NPROC` is counted per uid across the whole Docker VM, so a fixed uid with `nproc=64` could not even start (`exec /sbin/docker-init: resource temporarily unavailable`) and concurrent sandboxes would share one budget. `--pids-limit` (cgroup) remains the per-container fork-bomb bound.
- Round 2 (tester findings): out-of-memory is read from `docker inspect` (`State.OOMKilled`) before the explicit force-remove (no `--rm`), not inferred from exit 137; an uninspectable container (daemon unreachable, image missing) is a `runtime_unavailable` deny; `State.Error` other than program not found/not executable (126/127) is a deny; input file names over 100 bytes use GNU long-name tar entries, measured in UTF-8 bytes, and the archive is built before spawning so it cannot throw out of `run()`.
