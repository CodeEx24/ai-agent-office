# Per-run sandbox

Code and file tools run in a throwaway Docker container, never in the worker process.
Tickets: [AGO-71](../tickets/AGO-71.md) (created)

## How it works
- `SandboxRunner` (`apps/worker/src/sandbox/sandbox-runner.ts`) is the interface. `createDockerSandboxRunner()` is the Docker implementation (the `docker` CLI, no extra dependency).
- `run_code` (`run-code-tool.ts`) is the agent tool: tier 3, capability `code.run`. It is **not** on the default policy allowlist, so it is denied until the policy engine grants it. The loop calls the policy hook before `execute`, so the sandbox only ever runs after an allow.
- A call is `{command: string[], files?: [{path, content}]}`. Output is text: exit code, stdout, stderr.

## What the container gets
`--network none`, `--ipc none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, Docker's default seccomp and AppArmor profiles (never unconfined), `--init`, a random unprivileged uid per run, `--memory` = `--memory-swap`, `--cpus`, `--pids-limit`, `ulimit nofile/nproc/core`, and a size-capped `tmpfs` for `/work` and `/tmp`. No host path, no Docker socket, no environment variables. The base image is pinned by digest (`SANDBOX_IMAGE`); refresh it on purpose.

## Limits
Defaults: 10 s, 256 MiB, 1 CPU, 64 pids, 64 MiB scratch, 64 KiB output per stream. They are set by the worker (runner options), clamped to hard bounds, never by the model. Breaching one is a **typed deny** the loop logs as `tool_call.failed` (`sandbox_denied (<reason>)`): `timeout`, `out_of_memory`, `output_limit`, `aborted`, `invalid_request`, `runtime_unavailable`. Timeout means deny. The wall-clock kill removes the container and every process in it.

## Cleanup
Every container is labelled `ago.sandbox=true` and `ago.sandbox.run=<runId>`, inspected (`State.OOMKilled`, `State.Error`) after it stops, then force-removed in a `finally` on every path. A container Docker cannot inspect was never created (daemon unreachable, image missing), so the call is a `runtime_unavailable` deny and the code never runs on the host. A program's own exit code (even 137 or 125) is its result, never read as a sandbox failure. `removeLeftoverSandboxContainers()` reaps leftovers from a crashed worker.

## Tests
`apps/worker/src/sandbox/sandbox.test.ts` (flags, limits, validation, tool) always runs. `docker-runner.test.ts` runs real containers: DNS, raw TCP, HTTP to a host listener, Docker socket, abstract unix sockets, mount/clock/mknod, setuid, writes outside scratch, host paths, disk fill, fork bomb, memory blow-up, CPU spin, sleep past the limit, output flood, no container left behind. It skips with a printed reason when Docker (Linux containers) or the pinned image is missing. On Windows it needs Docker Desktop with the WSL2 backend; the first run pulls the image.

## Egress (AGO-65)
By default there is no network (`--network none`). A request carrying `egress: {hosts, ports}` (set by worker code from the workspace allowlist, never by the model) instead joins a per-run internal Docker network whose only neighbour is an egress proxy; the proxy is default deny and logs every block. If the proxy does not come up, the call is a `runtime_unavailable` deny and nothing runs. `run_code` does not pass `egress` yet. Details, allowlist format and tests: [egress-proxy](egress-proxy.md); [AGO-65](../tickets/AGO-65.md).

## Known limits
Needs Docker on the worker host. No files out (text only). `run_code` and `removeLeftoverSandboxContainers` are exported but not yet registered or called at worker start-up. An input file name under 200 characters but over 255 bytes passes validation and then fails inside the container (nothing runs; it reports exit 1, not `invalid_request`). Limits are not per-agent settings yet. Docker-in-CI is a follow-up.
