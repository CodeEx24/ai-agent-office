# Agent packs

Tickets: AGO-191 (created: format v1)

## What it does

A pack is one JSON file that moves a team of agents and their skills between computers. Today the code defines the **format (v1)**: how to read a pack, check it, and upgrade an older one. Export (AGO-192) and dry-run import (AGO-193) build on it and share the same code path. There is no screen, API or database table for packs yet.

A pack never contains secrets, database ids, run history, approval history, policies, identities or credentials.

## Screens

None yet. Editors can validate a pack with the generated JSON Schema file (see below). The future export and import screens (EP-19) will call `parseAgentPack`.

## Data model

Nothing is stored. A pack is plain JSON:

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
| tests | `packages/shared/src/packs/agent-pack*.test.ts` | Schema, migration, secret scan, JSON Schema staleness. |

## Rules and edge cases

- **Strict objects.** Every object is strict: a field the format does not name (`id`, `workspaceId`, `runs`, `approvals`, `apiKey`, ...) is rejected with its path.
- **Secret values.** Any string that looks like a secret value (provider keys, JWTs, PEM keys, `scheme://user:password@host`, including an empty user as in `redis://:password@host`) is rejected wherever it appears, with its path. Prose that only talks about keys or passwords is fine. The only way to point at a credential is a `secret:<name>` reference.
- **The secret scan is linear.** Pack text is untrusted, so the scan must not slow down on crafted text. The URL scheme is bounded to 30 characters and the JWT pattern starts after a lookbehind, so cost grows in step with text length. Strings longer than the largest field limit are skipped, because they already fail their length check. Known limit: a JWT glued directly after `-`, `_`, a letter or a digit is not matched.
- **No echo.** An issue message never repeats a secret-shaped name or reference; it says `(a value that looks like a secret)` and keeps the path.
- **Timing tests are growth-ratio checks.** The tests that guard linear cost compare run time at two input sizes (4x the text must cost under 11x the time, best of 5 runs, 2 ms floor), not a fixed number of milliseconds, so they do not fail on slow CI machines.
- **Versions.** `packVersion` is required. A newer version is refused with "update the app"; a gap in the chain or a step that does not bump the version is an error on `packVersion`. Migration does not mutate its input.
- **Untrusted text.** All pack text (prompts, skills, notes) is data, never instructions to the platform.
- **Not checked here.** Model allowlist, budget cap, capability tiers and Strict mode belong to the importer (AGO-193).

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
