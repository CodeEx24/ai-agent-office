# Agent packs

Tickets: AGO-191 (created: format v1), AGO-192 (export, checksum, `pack_events`)

## What it does

A pack is one JSON file that moves a team of agents and their skills between computers. The code defines the **format (v1)**: how to read a pack, check it, and upgrade an older one. **Export (AGO-192)** writes a pack from the agents you pick, through the API (`POST /api/agent-packs/export`) or the command `pnpm pack:export`; both call the same function. Dry-run import (AGO-193) builds on the same format. There is no export screen yet (EP-19).

A pack never contains secrets, database ids, run history, approval history, policies, identities or credentials.

## Screens

None yet. Editors can validate a pack with the generated JSON Schema file (see below). The future export and import screens (EP-19) will call the export API and `parseAgentPack`.

## Export

**What goes in.** The agents you select (or every active, non-archived agent when you select none) and only the skills those agents use. Per agent: name, role, model, thinking effort, prompt, mode (always written as `autonomyMode`), daily budget, skill names, and capabilities as `name` and `scope` only. Per skill: name, version, Markdown body. A missing daily budget exports as the default (500 cents). Departments, secret references and notes are not exported yet (no source for them).

**What stays out.** Workspace, agent and skill ids, credentials and tokens, agent identities, run history, run events, approvals, policies and budget usage. The loader selects named columns from five tables only (`agents`, `agent_skills`, `agent_capabilities`, `skills`, `capabilities`), so those cannot reach the file even by mistake. If a prompt or skill holds a secret-shaped value the export is refused (`invalid_pack`) and nothing is logged.

**Same bytes every time.** The file is the canonical JSON of the pack (object keys sorted, no whitespace) plus one final newline. Agents, skills and capabilities are sorted by name. The same agents at the same `exportedAt` give the same bytes.

**Checksum (what exactly is hashed).** The pack has an optional top-level `checksum`: `{ "algorithm": "sha256", "value": "<64 lowercase hex>" }`. The value is the SHA-256 of the UTF-8 bytes of the canonical JSON of the same pack **with the `checksum` field removed** (`exportedAt` is part of those bytes; there is no trailing newline in the hashed bytes). To check a file by hand: parse it, delete `checksum`, serialise with sorted keys and no whitespace, hash with SHA-256. `verifyPackChecksum` does this and answers `missing`, `valid` or `mismatch`. It catches accidental edits and tampering with a pack that kept its checksum; it is not a signature (someone who edits the pack can recompute it). Packs written before export existed have no checksum and stay valid.

**Who may export.** A signed-in member or owner of the workspace; a viewer may not. Agent credentials are refused first on the API (human-only route), and `record_pack_export` re-checks the role in the database.

**The audit event.** Every export is written to `pack_events` **before** the file is returned, so a failed log means no file. The row holds the exporter (the member id the database derives from the session, never a value the caller sends), the agent ids and names, the skill count and the checksum. It never holds pack content. The table is append-only: UPDATE, DELETE and TRUNCATE are blocked for every role, and workspace members can read it through row-level security.

### API

`POST /api/agent-packs/export`, JSON body `{ "workspace_id": "<uuid>", "agent_ids": ["<uuid>", ...], "name": "<text>" }`. `agent_ids` and `name` are optional (default: every active agent, name `Agent pack`). Unknown fields are a 400.

| Status | Meaning |
|---|---|
| 200 | The pack as a download (`Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Pack-Checksum`). |
| 400 | Bad body. |
| 401 / 403 | Signed out / not a member, a viewer, or an agent credential. |
| 404 | An agent was not found in the workspace (the whole export fails, no partial pack), or there is nothing to export. |
| 415 | The body is not JSON. |
| 422 | The data cannot form a valid pack (for example a secret-shaped value). |
| 500 | The export or its log failed; nothing is returned. |

### Command line

```
pnpm pack:export --workspace <uuid> [--agent <uuid> ...] [--name <text>] [--out <file>]
```

The command signs in **as you** with the public anon key, so row-level security and the role check apply exactly as on the API. There is no service-role key anywhere in the export path (a test scans for it). It reads these environment variables (names only; the values stay in your own shell or `apps/web/.env.local`, which is not committed):

| Variable | What |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase API URL (the same one the web app uses). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The public anon key. |
| `AGO_CLI_EMAIL` | Your account email. |
| `AGO_CLI_PASSWORD` | Your account password. |

The app's own sign-in is passwordless, so your account needs a password for the command line: see `docs/actions/set-pack-cli-password.md`. The command never prints the password or the session token, signs out when it finishes, and a wrong login prints one fixed line (`Sign-in failed. Check AGO_CLI_EMAIL and AGO_CLI_PASSWORD.`), never the server's text. `--out` defaults to `agent-pack.json` in the folder where you typed the command. Exit codes: 0 done, 1 failed, 2 bad usage or missing variables.

## Data model

One table: `pack_events`, the append-only export log described above (migration `20261114020001_ago_192_pack_events.sql`, rollback in `supabase/rollbacks/`). Packs themselves are not stored. A pack is plain JSON:

```json
{
  "$schema": "./agent-pack.v1.schema.json",
  "packVersion": 1,
  "metadata": { "name": "Research team", "exportedAt": "2026-11-13T00:00:00Z", "appVersion": "0.1.0" },
  "agents": [
    {
      "name": "Scout",
      "role": "Researcher",
      "model": "claude-sonnet-5-5",
      "thinkingEffort": "medium",
      "prompt": "Find sources and summarise them.",
      "skills": ["Citing sources"],
      "capabilities": [{ "name": "vault.read", "scope": "workspace" }],
      "dailyBudgetCents": 500,
      "autonomyMode": "strict",
      "department": "Research",
      "secretRefs": ["secret:crm_api_key"]
    }
  ],
  "skills": [{ "name": "Citing sources", "version": 3, "body": "# Citing\n\nAlways link the source." }],
  "notes": [{ "title": "Hand-off", "body": "Review weekly." }]
}
```

| Field | Rule |
|---|---|
| `packVersion` | Required whole number. Older versions are upgraded first; a newer version than the app knows is refused. |
| `checksum` | Optional (AGO-192). `{ algorithm: "sha256", value }`: SHA-256 of the canonical JSON of the pack without this field. See Export. |
| `metadata` | `name`, `exportedAt` (ISO 8601), `appVersion` (the exporting app). |
| `agents[].model` | Bounded text. The **importer** checks it against the allowlist and reports an unknown model; the schema stays valid across app versions. |
| `agents[].thinkingEffort` | `low`, `medium` or `high`. |
| `agents[].skills` | Names of entries in `skills[]`; each must exist, no repeats. |
| `agents[].capabilities` | `name` is the catalog key, `scope` one of `workspace`, `agent`, `external`, `sandbox`. No tier, no mode: the importer reads tiers from the catalog. No repeated name. |
| `agents[].dailyBudgetCents` | Whole US cents. The workspace cap is applied by the importer, not here. |
| `agents[].autonomyMode` | `strict` or `standard`, informational. Import always lands agents in Strict mode. |
| `agents[].department` | A department **name**, never an id. Optional. |
| `agents[].secretRefs` | Optional list of `secret:<name>` references. Names only, never values. No repeats. |
| `skills[]` | `name` (unique), `version` (whole number, 1 or more), Markdown `body`. |
| `notes[]` | Optional, `title` and Markdown `body`. |

Agent names are unique within a pack. Text limits reuse the existing agent and skill limits; pack-wide counts are capped (100 agents, 500 skills, 500 notes).

## Data flow

```mermaid
flowchart LR
  Caller[Export, import, API, CLI or UI] --> Parse[parseAgentPack]
  Parse --> Migrate[migrateAgentPack]
  Migrate --> Chain[PACK_MIGRATIONS]
  Migrate --> Schema[agentPackSchema]
  Schema --> Refine[refinePack]
  Refine --> Scan[findSecretShape]
  Schema --> Result[ok pack, or issues with paths]
  Schema -.generates.-> Gen[buildAgentPackJsonSchema]
  Gen --> File[(schemas/agent-pack.v1.schema.json)]
```

`parseAgentPack` migrates first (version check and upgrade steps), then validates the shape, then runs the cross-field rules and the secret scan. Nothing is read from or written to a database or the network.

## Main functions and files

| function / component | file | role |
|---|---|---|
| `parseAgentPack` | `packages/shared/src/packs/agent-pack-migrate.ts` | Migrate, then validate. The only entry point export, import, API, CLI and UI should use. Returns `{ ok: true, pack, fromVersion }` or `{ ok: false, issues: [{ path, message }] }`. |
| `migrateAgentPack`, `PACK_MIGRATIONS` | same | Requires `packVersion`, refuses newer versions and gaps, runs per-version steps. Steps are keyed by the version they upgrade from; v1 has none yet. |
| `agentPackSchema` and the `pack*Schema` parts | `packages/shared/src/packs/agent-pack-schemas.ts` | The strict Zod schema of the pack and its pieces; `PACK_VERSION` and the length limits. |
| `refinePack` | same | Unique names, skills that exist, no repeated capability or secret reference, secret scan of every string. |
| `findSecretShape` | same | Label of the first secret-shaped value in a string, or `null`. |
| `buildAgentPackJsonSchema`, `renderAgentPackJsonSchema` | `packages/shared/src/packs/agent-pack-json-schema.ts` | Build the JSON Schema from the Zod schema and render the exact file text. |
| `generate-agent-pack-schema.mjs` | `packages/shared/tools/` | Writes the committed schema; `--check` fails when it is stale. |
| `agent-pack.schema.json` export | `packages/shared/package.json` | Exposes the committed schema as `@ago/shared/agent-pack.schema.json`. |
| `buildAgentPack` | `packages/shared/src/packs/agent-pack-export.ts` (import from `@ago/shared/pack-export`, node only) | Turns plain source data into a validated, sorted pack with its checksum and the exact file text. Pure: no database. |
| `computePackChecksum`, `verifyPackChecksum`, `withoutChecksum` | same | Hash the canonical bytes; check a pack's checksum (`missing`, `valid`, `mismatch`). |
| `canonicalJson` | `packages/shared/src/packs/canonical-json.ts` | Sorted keys, no whitespace; array order kept. Browser-safe. |
| `exportAgentPack`, `ExportAgentPackError` | `apps/web/src/features/packs/export-agent-pack.ts` | The loader: reads the five tables as the caller, builds the pack, logs the event, returns the file. Serves the API and the CLI. |
| `exportAgentPackRequestSchema` | `apps/web/src/features/packs/export-request.ts` | Zod body of the API; the CLI validates its flags with it too. |
| `POST` | `apps/web/src/app/api/agent-packs/export/route.ts` | Thin route: human-only guard, JSON check, Zod, member role, loader, download headers. |
| `runPackExport` | `apps/web/src/features/packs/cli/run-pack-export.ts` | The command: flags, environment, sign-in, loader, write file. Dependencies are injected for tests; `pack-export.ts` wires the real ones. |
| `record_pack_export`, `pack_events` | `supabase/migrations/20261114020001_ago_192_pack_events.sql` | The append-only log and its only writer (member-checked, security definer). |
| tests | `packages/shared/src/packs/agent-pack*.test.ts`, `apps/web/src/features/packs/**/*.test.ts`, `apps/web/src/app/api/agent-packs/export/route.test.ts`, `supabase/tests/pack_events.test.sql` | Schema, migration, secret scan, JSON Schema staleness, export, checksum, route, CLI, no-service-role scan, table rules. |

## Rules and edge cases

- **Strict objects.** Every object is strict: a field the format does not name (`id`, `workspaceId`, `runs`, `approvals`, `apiKey`, ...) is rejected with its path.
- **Secret values.** Any string that looks like a secret value (provider keys, JWTs, PEM keys, `scheme://user:password@host`, including an empty user as in `redis://:password@host`) is rejected wherever it appears, with its path. Prose that only talks about keys or passwords is fine. The only way to point at a credential is a `secret:<name>` reference.
- **The secret scan is linear.** Pack text is untrusted, so the scan must not slow down on crafted text. The URL scheme is bounded to 30 characters and the JWT pattern starts after a lookbehind, so cost grows in step with text length. Strings longer than the largest field limit are skipped, because they already fail their length check. Known limit: a JWT glued directly after `-`, `_`, a letter or a digit is not matched.
- **No echo.** An issue message never repeats a secret-shaped name or reference; it says `(a value that looks like a secret)` and keeps the path.
- **Timing tests are growth-ratio checks.** The tests that guard linear cost compare run time at two input sizes (4x the text must cost under 11x the time, best of 5 runs, 2 ms floor), not a fixed number of milliseconds, so they do not fail on slow CI machines.
- **Versions.** `packVersion` is required. A newer version is refused with "update the app"; a gap in the chain or a step that does not bump the version is an error on `packVersion`. Migration does not mutate its input.
- **Untrusted text.** All pack text (prompts, skills, notes) is data, never instructions to the platform.
- **Not checked here.** Model allowlist, budget cap, capability tiers and Strict mode belong to the importer (AGO-193).
- **Export edge cases.** A grant whose catalog row is gone is refused (`invalid_pack`) rather than exported with a guessed scope. A repeated agent id counts once. Archived agents are exported only when named. A failed event write fails the whole export.
- **Known limits.** Import does not verify the checksum yet (AGO-193 should call `verifyPackChecksum` and report a mismatch). The checksum is not a signature (AGO-199). The CLI needs the repo (it builds `@ago/shared` first) and Node 24.

## How to extend it

- **Add a field:** edit `agent-pack-schemas.ts`, then regenerate the schema file. A change that older packs cannot satisfy needs a new `PACK_VERSION` and a migration step in `PACK_MIGRATIONS` (see below). Never add an id, credential or history field.
- **New format version:** bump `PACK_VERSION`, add `1: (pack) => ({ ...pack, packVersion: 2, ... })` to `PACK_MIGRATIONS`, and update `agent-pack-json-schema.ts` output name (the file name follows the version).
- **New secret shape:** add it to `EXTRA_SECRET_SHAPES` (or the shared redaction list), keep it linear, and add a growth-ratio test next to the existing ones in `agent-pack.round2.test.ts`.
- **A new rule across fields:** add it to `refinePack` with a field path.

### The JSON Schema file

`packages/shared/schemas/agent-pack.v1.schema.json` is generated from the Zod schema and committed so editors can validate packs (add `"$schema"` to a pack, or map the file in the editor).

- Regenerate: `pnpm --filter @ago/shared pack:schema`
- Check only: `pnpm --filter @ago/shared pack:schema:check`
- CI: a test in `pnpm test` fails when the committed file is stale, so the check runs in the existing CI test step.

JSON Schema cannot express the cross-field rules (unique names, skills that exist, no secret-shaped values); the Zod schema is the authority and the file is for editor hints.
