# Egress proxy

A sandboxed run that needs the network reaches it only through a proxy we run, and the proxy is default deny.
Tickets: [AGO-65](../tickets/AGO-65.md) (created). Builds on the [per-run sandbox](sandbox.md).

## How it works
- A run without `egress` keeps `--network none` exactly as before.
- A run with `SandboxRequest.egress = {hosts, ports}` (set by worker code from the workspace allowlist, never by the model) gets a per-run topology:
  1. an `--internal` Docker network (no gateway, no outside DNS);
  2. a proxy container started on that network only; it binds to its single internal address and prints `egress.ready`;
  3. only then is the proxy also joined to Docker's default `bridge`, which is its only way out;
  4. the sandbox container joins the internal network only, with `HTTP_PROXY` / `HTTPS_PROXY` pointing at the proxy.
- So a bypass (direct IP, IPv6, an outside DNS resolver, another proxy port, the metadata IP) has **no route at all**. Nothing relies on the program honouring the proxy variables.
- Fail closed: no ready proxy means a typed `denied: runtime_unavailable` and no sandbox starts. There is never a direct fallback. An empty or invalid allowlist allows nothing.

## What the proxy allows
- HTTP (absolute-form) and `CONNECT` go through one `authorize()`. HTTPS is allowlisted by the CONNECT host only (no TLS interception).
- Hosts: an exact name, or `*.example.com` (any subdomain, not the apex). Never a bare `*`, a TLD wildcard (`*.com`) or an IP literal. Names are lowercased, a trailing dot is dropped and IDNs become punycode.
- Ports: the workspace list, default 80 and 443.
- The host is resolved once. If **any** answer is private, loopback, link-local, metadata (`169.254.169.254`), CGNAT, multicast, unspecified, IPv4-mapped, 6to4, Teredo, documentation or ULA, the request is blocked (`private_address`). The connection then goes to the checked IP, so a second lookup cannot rebind it.
- A `Host` header that disagrees with the target is blocked (`host_mismatch`); duplicate `Host` headers are rejected. Redirects are passed back to the client untouched, never followed.
- Caps: connections, header size, idle time and total time. A timeout is a deny. No admin or metrics port exists.
- The container is the pinned `node:24-alpine` digest, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, uid 65532, 128 MiB, 0.5 CPU, 64 pids, no host mount, no published port.

## Logging
One JSON line per decision on the proxy's stdout: `{event, run_id, workspace_id, host, port, method, reason?}`. Never the URL path, query, headers or bodies. `reason` is one of `not_allowlisted`, `port_not_allowed`, `private_address`, `invalid_host`, `host_mismatch`, `resolve_failed`, `too_many_connections`, `bad_request`, `timeout`, `upstream_error`. The launcher parses the lines and calls `onDecision`; `createEgressDecisionLogger(logger)` writes the blocks to the structured logger at `warn`. No table or column was added.

## The allowlist
A JSON file named by `EGRESS_ALLOWLIST_FILE`, edited by a human on the worker host (no tool an agent can call reaches it). It is re-read on every call, so edits apply to the next run.

```json
{ "version": 1, "workspaces": { "<workspace id>": { "hosts": ["api.example.com", "*.cdn.example.com"], "ports": [443] } } }
```

Validated by a strict Zod schema in `@ago/shared` (`egressAllowlistFileSchema`). A missing, unreadable, unparsable or invalid file, any bad host entry, an unlisted workspace or an empty list all mean **deny all**, with a warning that never prints the contents. Owner steps: [set-egress-allowlist](../actions/set-egress-allowlist.md).

## Cleanup
The proxy and the network are labelled `ago.egress=true` and `ago.egress.run=<runId>` and removed in a `finally` on every path (finished, failed, aborted). `removeLeftoverEgressResources()` reaps leftovers and is called from `removeLeftoverSandboxContainers()`.

## Tests
- `egress-proxy.test.ts`, `egress-config.test.ts` and the shared schema test always run: normalisation, matching, address ranges, an in-process proxy with a stub resolver (blocks logged with the exact object, redirects not followed, rebinding, mixed answers, Host mismatch, CONNECT), the allowlist loader, container flags.
- `egress.docker.test.ts` runs real containers and checks the proxy from outside the sandbox: bypass probes from inside the sandbox all fail; an allowlisted host works through the proxy; every other host gets a 403 with a logged reason and the target server records only the allowed hits; an empty allowlist blocks all; a killed proxy means no direct connection; no container or network is left behind. It skips with a printed reason when Docker or the images are missing. It never calls a real third-party host (the target is a local container).
- `egress-acceptance.test.ts` and `egress-acceptance.docker.test.ts` are the acceptance suites (log content, caps, real resolver, abort cleanup, no egress means no network). The docker suites skip in CI until Docker-in-CI (AGO-238).
- Test-only knobs exist on the runner options (`unsafeAllowEgressAddressesForTests`, `egressAddHostsForTests`; they reach the proxy as `unsafeAllowAddressesForTests` and `addHostsForTests`). They are not reachable from the allowlist file.

## Known limits
Needs Docker on the worker host. A client can still lie about SNI inside an allowed CONNECT tunnel. Each egress run starts its own proxy (about a second). The allowlist is a file: no UI or per-workspace storage yet. `run_code` is not wired to egress; that belongs with AGO-85. Docker-in-CI for the real-container suite is AGO-238.
