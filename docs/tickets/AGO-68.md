# AGO-68 - Allowlist and pin tool servers (US-111)

- Ticket: https://stratyge.atlassian.net/browse/AGO-68
- PRs: https://github.com/CodeEx24/ai-agent-office/pull/82
- Related: AGO-157 (credential broker, done), AGO-34 (policy engine), AGO-25 (tool offer), AGO-88 (read-only MCP integrations, unblocked by this), AGO-129 (red-team suite), AGO-154 (proposal-store precedent)
- Status: In progress (record accepted 2026-11-17) · Type: Feature · Risk: high (tool supply chain, tool-description tampering, token passthrough) · Epic EP-17 · Wave 3

## Overview
Agents may only reach tool servers a workspace owner has allowlisted. Each allowlisted server is pinned by a hash of its identity and its tool list (names, descriptions, input schemas). On connect the worker snapshots the tool list and diffs it against the pin. A changed tool is blocked and an alert is raised until a human reviews and re-pins. Tool servers only ever receive broker-issued, audience-bound credentials; a user token, an agent token or a token meant for another audience is never forwarded.

## Acceptance criteria (verbatim)
1. Unlisted servers are blocked
2. A changed tool description raises an alert and blocks the tool until reviewed
3. Passthrough tokens are rejected
4. Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done).

## Implementation details
New module `apps/worker/src/tool-servers/`:
- `canonical-hash.ts`: stable JSON (recursively sorted keys, no whitespace, UTF-8, NFC-normalised strings) then sha256. Hashed per tool: `{name, description, inputSchema}`; the server pin hashes `{serverId, version, tools sorted by name}`. Output schemas and annotations are included in the tool hash when present (a changed annotation such as `readOnlyHint` is a security-relevant change).
- `registry.ts`: `ToolServerRegistry` port (`getEntry(workspaceId, serverId)`), entries `{serverId, workspaceId, endpoint id, audience, pinnedHash, pinnedTools[], pinnedBy, pinnedAt}`. Only the human review path can write pins. In-memory implementation now (the `proposal-store.ts` precedent, AGO-154); a Postgres implementation is a follow-up that needs the schema slot.
- `snapshot-diff.ts`: diff of two tool lists into `added | removed | description_changed | schema_changed`. Any non-empty diff is a change.
- `tool-server-gate.ts`: `checkServer(scope, serverId, liveTools)` returns `{ok:true, tools}` or a typed deny: `server_not_allowlisted`, `pin_missing`, `hash_mismatch`, `snapshot_unavailable`, `diff_error`. Fails closed on any thrown error. Logs agent and server on every deny and raises an alert on `hash_mismatch`.
- `audience.ts`: token audience checks on top of the AGO-157 broker (see decisions).
- Wiring: `tool-offer.ts` gets an additive optional `serverGate` dep; a tool tagged with a `serverId` is offered only when the gate allows its server. A tool with a `serverId` and no gate configured is not offered (fail closed). Built-ins and non-server tools behave exactly as before. The loop's policy check is untouched and still runs for every offered call; the gate is an extra layer, never a replacement.
- Shared types and Zod schemas (allowlist entry, pin, snapshot, deny reasons) additively in `packages/shared/src/tool-servers/`, exported through the barrel.

Alert channel (reuse-first): no alert/notification mechanism exists in the repo. The existing append-only `run_events` has `error.raised {code, message, retryable}`; a change is emitted as `error.raised` with code `tool_server_changed` (message names server and counts, never the description text). No new event type, so no migration (the type has no DB check constraint). A richer notification (Telegram, UI badge) can read these events later.

## Boundaries
- **Always:** scope by workspace_id; policy check before every tool call stays intact and in order; fail closed; log agent and server on every deny; Zod at boundaries; fake tool servers only in tests.
- **Ask first:** the Postgres table for allowlist, pins and snapshots (schema slot is held by AGO-194); any new dependency.
- **Never:** let an agent approve, pin or re-pin; forward a user or agent token to a tool server; log descriptions or tokens; edit run_events.

## API changes
None in this ticket. The human review/re-pin action is a worker-side function (`reviewAndPin`) that requires a human actor; the web route and UI that call it are a follow-up (they need the table). The function rejects an agent credential (`hasAgentCredential`) before doing anything.

## Database changes
None (no migration). Allowlist and pins are in-memory behind the registry port for now. Follow-up ticket: `tool_servers` and pins tables with RLS.

## Decisions (recommended option taken unless the owner changes it)
| # | Question | Decision | By / when |
|---|---|---|---|
| D1 | Where allowlist and pins live | Port + in-memory store now; Postgres in a follow-up when the schema slot frees (alternative: workspace config file, rejected: not RLS-protected and awkward for the human review write path) | owner, 2026-11-17 |
| D2 | Canonical hashing | Sorted-key JSON, NFC strings, sha256; per tool `{name, description, inputSchema (+outputSchema, annotations if present)}`; server pin adds `serverId`, `version`; tools sorted by name | owner, 2026-11-17 |
| D3 | What counts as a change | Any difference: description, input schema, annotations, tool added, tool removed, server version/identity. Any change blocks the whole server until reviewed (simplest safe rule) | owner, 2026-11-17 |
| D4 | Human review and re-pin | `reviewAndPin` takes the reviewed snapshot hash and a human actor; it pins exactly the snapshot the reviewer saw, bound to its hash; agent credentials rejected; audit event | owner, 2026-11-17 |
| D5 | Passthrough detection | A tool-server call carries only a broker-issued token whose `aud` equals the server's registered audience. Rejected: any `ago_agt_` agent token, any token with no or a different `aud`, any token the broker did not issue, any outbound auth equal to the inbound run credential or a human session token | owner, 2026-11-17 |

D11 (added in FIX r2, owner answer 2026-11-17 under the standing "go with recommendation" rule): a hash mismatch is a sticky block. The first mismatch records a blocked state per (workspace, server) with the observed hash and time; while it is set the server is neither offered nor callable even if the live hash equals the pin again, so a server cannot flip a malicious description on, act, and flip it off. Only a human `reviewAndPin` clears it (pinning the original or the new snapshot); re-allowlisting also clears it. The gate can only write the block (`ToolServerBlockRecorder`: `markBlocked`, `markAlerted`), never unblock. The alert fires on the first mismatch, then once per new distinct hash (no flood, also across runs). Supersedes the earlier once-per-run-and-hash alert rule. The alert is claimed atomically (FIX r3, after the tester found 25 parallel checks raising 25 alerts): `claimAlert(workspaceId, serverId, observedHash, at)` on the recorder port sets the blocked state and the alerted hash in one step and returns true only for the first caller per (workspace, server, hash); `releaseAlert` gives the claim back if the sink fails. Blocking is independent of the claim: every caller is denied whether or not it won. **Requirement for the Postgres follow-up:** implement `claimAlert` as one conditional statement (`INSERT ... ON CONFLICT DO NOTHING RETURNING` on a unique (workspace_id, server_id, hash) row, true only when a row is returned), never a read followed by a write.

All of D1-D5 accepted by Jocarl Basco (owner), 2026-11-17, with these additions:
| # | Addition | By / when |
|---|---|---|
| D6 | The store port is keyed by workspace_id on every method; a pin or review in one workspace never affects another | owner, 2026-11-17 |
| D7 | An empty or freshly restarted store fails closed: every server is unlisted and blocked. No trust on first use: the first pin is a human `reviewAndPin` too | owner, 2026-11-17 |
| D8 | `reviewAndPin` pins the exact snapshot hash the human reviewed; the live hash must still equal it at pin time, so a server that changes between review and pin stays blocked | owner, 2026-11-17 |
| D9 | The run event holds no tokens and no full schemas: hashes plus a bounded diff summary (counts and tool names); descriptions are untrusted text and never copied | owner, 2026-11-17 |
| D10 | The Postgres store is a follow-up; the owner files it at merge | owner, 2026-11-17 |

## Known limitations
No Postgres persistence, no web UI for review (follow-ups). Live MCP transport is not part of this ticket (AGO-88): the gate works on a `ToolServerClient` interface (`listTools()`); tests use local fake servers.

## Testing notes
Vitest unit tests per module; integration test with an in-process fake tool server whose description changes mid-test; file-level `vi.setConfig` timeout. AC map: AC1 unlisted and other-workspace entry blocked; AC2 description change alerts and blocks, human re-pin unblocks, agent re-pin refused; AC3 agent token, wrong audience, missing audience, human token all rejected; fail-closed cases (snapshot unavailable, diff throws). No DB tests, no real network.

## Follow-up tasks
- Postgres `tool_servers`/pins tables with RLS (needs schema slot).
- Web route and UI for review and re-pin (human-only route).
- Notification (Telegram/UI) reading `tool_server_changed` events.
- AGO-88 wires real MCP clients through this gate.
- Token replay (security review r1, accepted for this ticket): audience tokens live 5 minutes and are bound to one audience, workspace, run and agent, but not to one tool or input, and there is no `jti` store. No transport exists yet, so nothing crosses a network here. To land with AGO-88: HTTPS-only endpoints, one token per call bound to tool name and an input hash, a `jti` replay cache on the verifying (tool server) side, and a shorter TTL.
- The follow-up web route must take workspace and user from the verified session and check the owner role before calling `allowlistServer`, `prepareReview` or `reviewAndPin`.
- Resolved as D11: a mismatch stays blocked until a human re-pins, even if the server changes back.

## Outcome
Built: gate, registry port (in-memory), canonical hash and diff, human review and pin, audience-bound tokens through the broker, run-event alert, tool-offer wiring. Guide: docs/features/tool-servers.md. Postgres store: follow-up (owner files it at merge).
