# Agent packs

A pack is one JSON file that moves a team of agents and their skills between computers. This guide covers the **format (v1)** from AGO-191. Export (AGO-192) and dry-run import (AGO-193) build on it and share the same code path.

## The format

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
| `agents[].capabilities` | `name` is the catalog key, `scope` one of `workspace`, `agent`, `external`, `sandbox`. No tier, no mode: the importer reads tiers from the catalog. |
| `agents[].dailyBudgetCents` | Whole US cents. The workspace cap is applied by the importer, not here. |
| `agents[].autonomyMode` | `strict` or `standard`, informational. Import always lands agents in Strict mode. |
| `agents[].department` | A department **name**, never an id. Optional. |
| `agents[].secretRefs` | Optional list of `secret:<name>` references. Names only, never values. |
| `skills[]` | `name`, `version` (whole number, 1 or more), Markdown `body`. |
| `notes[]` | Optional, `title` and Markdown `body`. |

## What a pack never contains

Secrets, database ids, run history, approval history, policies, identities and credentials. Every object is **strict**: a field the format does not name (`id`, `workspaceId`, `runs`, `approvals`, `apiKey`, ...) is rejected with its path. Any string that looks like a secret value (provider keys, JWTs, PEM keys, `scheme://user:password@host`) is rejected wherever it appears, with its path. The only way to point at a credential is a `secret:<name>` reference.

All pack text (prompts, skills, notes) is untrusted data, never instructions to the platform.

## Using it in code

```ts
import { parseAgentPack } from "@ago/shared";

const result = parseAgentPack(JSON.parse(text));
if (!result.ok) {
  // result.issues: [{ path: "agents.0.dailyBudgetCents", message: "..." }]
}
```

`parseAgentPack` migrates, then validates, and is the only entry point export, import, API, CLI and UI should use. `migrateAgentPack` alone returns the upgraded but unvalidated pack. Migration steps live in `PACK_MIGRATIONS` in `packages/shared/src/packs/agent-pack-migrate.ts`, keyed by the version they upgrade from; v1 has none yet.

## The JSON Schema file

`packages/shared/schemas/agent-pack.v1.schema.json` is generated from the Zod schema and committed so editors can validate packs (add `"$schema"` to a pack, or map the file in the editor). It is also exported as `@ago/shared/agent-pack.schema.json`.

- Regenerate: `pnpm --filter @ago/shared pack:schema`
- Check only: `pnpm --filter @ago/shared pack:schema:check`
- CI: a test in `pnpm test` fails when the committed file is stale, so the check runs in the existing CI test step.

JSON Schema cannot express the cross-field rules (unique names, skills that exist, no secret-shaped values); the Zod schema is the authority and the file is for editor hints.

## Changing the format

Change `agent-pack-schemas.ts`, add a migration for the old version and bump `PACK_VERSION` when a change is not backward compatible, then regenerate the schema file. Never add an id, credential or history field.
