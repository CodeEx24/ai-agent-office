# AGO-65 - Add the egress proxy with allowlist

Status: In progress (record accepted 2026-11-20)

## Links
- Ticket: [AGO-65](https://stratyge.atlassian.net/browse/AGO-65) (US-110), epic EP-17, wave 3
- PRs: [#86](https://github.com/CodeEx24/ai-agent-office/pull/86) (draft)
- Related: AGO-71 (per-run sandbox, done), AGO-85 (capability prerequisites), AGO-129 (red-team suite), AGO-104 (log shipping), AGO-113 (schema slot)

## Overview
Risk: high (network isolation boundary). Type: Feature.

Route all outbound traffic of a sandboxed run through our proxy, with default deny. A run that needs no egress keeps `--network none` (AGO-71, unchanged). A run that does need egress gets no route to anywhere except the proxy; the proxy allows only hosts on the workspace allowlist and logs every block. Empty or unreadable allowlist blocks everything; a proxy that is down means deny, never a direct connection.

Acceptance criteria (verbatim):
- Requests to non-allowlisted hosts are blocked and logged
- The proxy is verified from outside the sandbox
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Design (proposed)
**Topology (per run).** The runner creates an `--internal` Docker network (no gateway, no outside DNS) and starts a proxy container attached to that network and to Docker's default bridge (its only way out). The sandbox container joins only the internal network, with `HTTP(S)_PROXY` pointing at the proxy's IP. So a bypass (direct IP, IPv6, outside DNS resolver, other ports) has no route at all; it does not rely on the process honouring the proxy variables. Container, network and labels (`ago.egress=true`, `ago.egress.run=<id>`) are removed in a `finally` on every path; the leftover reaper covers them. Per-run proxy means the allowlist and the `run_id` / `workspace_id` in each log line are fixed at start, with no shared mutable state.

**Proxy: custom, zero dependencies.** One self-contained erasable-syntax TS file `apps/worker/src/egress/egress-proxy.ts` (only `node:` imports): HTTP forward proxy plus CONNECT tunnel (no TLS interception). It runs in a digest-pinned `node:24-alpine` container (free, open source), `--read-only`, `--cap-drop ALL`, no-new-privileges, memory and pids limits, non-root. The file is piped on stdin (`node --input-type=module-typescript -`), so the container needs no build and no host mount; in `dist` the same module is plain JS and also valid input. The same module is imported by unit tests.

**Rules.** Default deny. Exact host plus explicit `*.domain` wildcard (never the bare apex for a wildcard, never a bare `*`). Hosts normalised (case, trailing dot, IDN to punycode via `domainToASCII`; IP literals are rejected as hosts). Ports limited to 80 and 443 by default. Resolve once, check every resolved address against private, loopback, link-local, metadata (169.254.169.254), CGNAT, multicast, unspecified, IPv4-mapped and ULA ranges, then connect to the checked IP (pinned, so no second resolution can rebind). No admin port; only the one listener. Connection count, header size and idle/total time are capped.

**Logging.** One JSON line per decision on the proxy's stdout: `{event, run_id, workspace_id, host, port, method, reason}`. Never URL path, query, headers or bodies. The worker reads the proxy output when the run ends and re-emits blocked entries through the structured logger (scrubbed) and an `onDecision` callback (callers can write run_events via the existing path). No new table or column.

**Config and who sets it.** Allowlist is a typed JSON file (`EGRESS_ALLOWLIST_FILE`) validated by a Zod schema in `packages/shared/src/egress/`: `{ version: 1, workspaces: { <workspaceId>: { hosts: string[], ports?: number[] } } }`. Edited by humans on the host; no agent-facing path to it. Missing file, parse error, unknown workspace: empty allowlist (deny all) plus a warning. UI or DB storage of the allowlist is out of scope (follow-up ticket).

**Sandbox integration.** `SandboxRequest` gains optional `egress` (set by worker code, never by the model). Without it: `--network none` exactly as today. With it: proxy first; if it is not ready in time, `denied: runtime_unavailable` (egress proxy unavailable) and no sandbox starts. `run_code` stays with no egress; wiring a workspace setting into the tool belongs with AGO-85 (capability gating).

## Implementation details (as built)
- `packages/shared/src/egress/`: `egressAllowlistFileSchema` (strict), host pattern schema, block reasons, decision schema, limits (200 hosts, 10 ports per workspace).
- `apps/worker/src/egress/egress-proxy.ts`: the proxy (`createEgressProxy`, `normalizeHost`, `compileAllowlist`, `isHostAllowed`, `isBlockedAddress`; `main()` runs only when `EGRESS_PROXY_MAIN=1`).
- `apps/worker/src/egress/egress-launcher.ts`: creates the internal network, starts the proxy by piping the source to `node --input-type=module-typescript -`, waits for `egress.ready`, joins the proxy to `bridge`, parses decisions, cleans up; `removeLeftoverEgressResources()`.
- `apps/worker/src/egress/allowlist-config.ts`: file provider with deny-all fallbacks.
- `sandbox-runner.ts` (`SandboxRequest.egress`, validation) and `docker-runner.ts` (internal network plus proxy env instead of `--network none`; `runtime_unavailable` when the proxy is not ready; stop on every path).
- Docs: `docs/features/egress-proxy.md`, an egress section in `docs/features/sandbox.md`, owner guide `docs/actions/set-egress-allowlist.md`.

## Deviations from the design
- Two test-only options on the runner (`unsafeAllowEgressAddressesForTests`, `egressAddHostsForTests`) let the real-container tests point fake host names at a local target and exercise the private-address block. They are options of code, not of the allowlist file, and are not set anywhere in production code.
- `sandbox/index.ts` is unchanged and `run_code` is unchanged (no egress), as the design said; the egress module has its own barrel `egress/index.ts`.
- The docs/actions list generator (`docs/actions/README.md`) does not exist in this worktree, so the owner to-do list was not regenerated; the guide has its front matter.

## Boundaries
- **Always:** default deny; fail closed; resolve-then-check-then-connect to the checked IP; remove proxy container and network on every path; log blocks without secrets.
- **Ask first:** schema changes, UI for the allowlist, CI changes (Docker-in-CI).
- **Never:** give the sandbox a route other than the proxy; run the proxy with `--network host` or any host mount; let an agent edit the allowlist; fall back to a direct connection.

## API changes
None (worker-internal). New exported types in `@ago/shared`: egress allowlist schema.

## Database changes
None. (Blocked-request logging uses the structured logger and existing run_events paths; AGO-113 holds the schema slot.)

## Dependencies on other tickets
AGO-71 (done). Unblocks AGO-85 and AGO-129.

## Known limitations (expected)
- Needs Docker on the worker host; real-container tests skip with a printed reason without it (as AGO-71).
- HTTPS is allowlisted by CONNECT host only (no TLS interception), so a client can still lie about SNI inside an allowed tunnel.
- Allowlist is file-based; no UI or per-workspace DB storage yet.
- One proxy per egress run (about a second of start-up); a shared proxy pool is a later optimisation.

## Testing notes
Unit (always run): host normalisation, wildcard matching, address-range blocking, resolver stub (DNS rebinding, mapped IPv6), decision logging (no query strings), allowlist loader (empty, unreadable, invalid, agent cannot widen), argument construction (`--internal`, no `--network bridge` for the sandbox). Real containers (skip with reason when Docker is missing): from inside a sandbox, direct IP, IPv6, outside DNS resolver, alternate ports, CONNECT to a non-allowlisted host, the proxy's own other ports, and the metadata IP all fail; an allowlisted host on a local test server works through the proxy; the non-allowlisted test server records zero connections; a stopped proxy means denied, not direct; no leftover containers or networks. No outbound calls to real third-party hosts; the test target is a local container.

## Follow-up tasks
- Inspect the proxy's SNI handling inside allowed CONNECT tunnels (a client can still name a different host in the TLS handshake; only a TLS-intercepting proxy closes this, which needs its own decision).
- UI and storage for the per-workspace allowlist (needs schema slot).
- Wire egress into `run_code` through workspace settings and capability gating (AGO-85).
- Docker-in-CI job for the real-container suites (already AGO-238).

## Outcome
(empty until merge)

## Decisions
| Decision | Who | When |
|---|---|---|
| Proxy: custom zero-dependency Node proxy in a digest-pinned node:24-alpine container, per run, on an internal Docker network | Owner via standing rule (recommended option) | 2026-11-20 |
| Add: Node built-in http/net only (no hand-rolled HTTP parsing); CONNECT and plain HTTP share one allowlist check; cap header size, connection count, idle and total time (timeout means deny); never follow redirects for the client; reject a request whose Host header and CONNECT target disagree; no admin or metrics port reachable from the sandbox; non-root, read-only root filesystem | Owner via standing rule | 2026-11-20 |
| Allowlist: typed JSON file with a Zod loader (empty, missing or invalid file means deny all); UI/DB storage proposed as a follow-up | Owner via standing rule | 2026-11-20 |
| Record accepted; build | Owner via standing rule | 2026-11-20 |
