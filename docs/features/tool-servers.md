# Tool servers: allowlist, pins and audience-bound tokens (AGO-68)

Agents can only reach external tool servers (for example MCP servers) that a person in the workspace has allowlisted and reviewed. This is a supply-chain control: a server can change what its tools say or do after you trusted it.

Code: `apps/worker/src/tool-servers/`, schemas in `packages/shared/src/tool-servers/`. Record: `docs/tickets/AGO-68.md`.

## How it works

1. **Allowlist (human).** `allowlistServer` registers a server for one workspace with its audience and the broker secret used to sign tokens for it. It is blocked (`pin_missing`) until reviewed.
2. **Review and pin (human).** `prepareReview` connects, snapshots the tool list and shows its hash and a diff against the current pin. `reviewAndPin` pins exactly the hash the person reviewed: the tool list is read again and must still hash to it, otherwise `snapshot_changed` and the server stays blocked. The first pin is a review too, so there is no trust on first use.
3. **Gate (every model call).** `createToolServerGate` re-reads the live tool list and compares its hash with the pin. The tool offer (`createToolOffer({ serverGate })`) offers a tool with a `serverId` only when it is granted **and** the gate allows its server. The policy engine still decides every offered call afterwards.
4. **Call.** `createToolServerCaller` runs the gate, then the credential broker (AGO-157) verifies the run's credential and capability and releases the signing key inside `withSecret`. A short token bound to the server's audience (`ago_tsv_...`) is minted and sent. The run's agent credential, a person's session token or a token for another audience is never forwarded.

## What is hashed and what counts as a change

The pin is sha256 of canonical JSON (keys sorted at every depth, strings NFC-normalised, no whitespace) of `{serverId, version, tools sorted by name}`. Every field a tool carries is included: description, input schema, annotations, anything else. Any difference (a description, a schema, an annotation, an added or removed tool, a new version, another identity) blocks the whole server until a person reviews it. A value that cannot be canonicalised, or a duplicate tool name, is a block (`diff_error`), not a skip.

## Fail closed

Unknown server, no pin, hash mismatch, tool list unavailable, diff error, a registry outage: the tool is not offered and not callable. A denial is logged with workspace, agent, run and server ids. An empty or restarted in-memory store blocks every server. Workspaces are isolated: every registry method takes the workspace id and one workspace's pin never affects another.

## Alerts

A hash mismatch raises an `error.raised` run event with code `tool_server_changed`, once per new distinct live hash. The message holds the server id, both hashes and a bounded summary (tool names cleaned to a safe alphabet, counts). It never holds descriptions, schemas or tokens, because descriptions are untrusted text. A failing alert sink does not unblock anything.

## A change stays blocked (D11)

The first mismatch records a block for that workspace and server (observed hash, time). While it is set the server is blocked even if its tools hash to the pin again, so a server cannot flip a bad description on, act, and flip it back. Only a person's `reviewAndPin` clears it (pinning the original or the new snapshot). The gate can set the block but never clear it. The alert is claimed atomically: the gate calls `claimAlert(workspace, server, hash, at)` on the registry's block recorder, which sets the block and the alerted hash in one step and returns true only for the first caller per hash. Parallel checks therefore raise one alert per distinct hash, and every caller is still denied whether or not it won the claim. If the alert sink fails, the gate calls `releaseAlert` so the next check tries again. Only the last 50 alerted hashes per server are kept (`MAX_ALERTED_HASHES`); forgetting an old one can repeat an alert but never unblocks.

When the live list matches the pin, the gate reads the registry entry again after the (server-controlled, possibly slow) listing and allows only if the pin is unchanged and no block is set. This stops a slow listing from carrying a stale "not blocked" past a block that another check recorded meanwhile.

## Human only

Allowlisting, reviewing and pinning check the actor (`kind: "human"`, a user id, no agent credential in the headers). The registry's write methods are given only to this path; the gate and the agent path get a read-only lookup. Agents never approve a changed tool.

## Not yet built (follow-ups)

- Postgres `tool_servers` and pins tables with RLS (needs the schema slot). Until then the registry is in memory and starts empty after a restart. The block must live in the same row as the pin, and `claimAlert` must be one conditional statement (`INSERT ... ON CONFLICT DO NOTHING RETURNING` on a unique workspace, server, hash row), never a read followed by a write.
- Token replay hardening with AGO-88: HTTPS-only endpoints, one token per call bound to tool name and input hash, a `jti` replay cache on the tool server side, shorter TTL (tokens last 5 minutes today).
- The review route must take workspace and user from the verified session and check the owner role.
- The web route and UI for review and re-pin (a human-only route).
- Notifications (Telegram, UI badge) that read the `tool_server_changed` events.
- AGO-88 connects real MCP clients behind `ToolServerClient` and `ToolServerTransport`.

## Testing

`pnpm --filter @ago/worker test -- src/tool-servers` runs unit and acceptance tests against local in-process fake tool servers that change their descriptions mid-test. No network, no database.
