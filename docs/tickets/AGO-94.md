# AGO-94 - Add per-agent model routing

## Overview
Jira: [AGO-94](https://stratyge.atlassian.net/browse/AGO-94) (US-049), epic EP-02, wave 2 (Agent Runtime + Guardrails).
Risk tier: high (AI-safety and cost surface: it decides which paid model a run calls).

Each agent now runs on the model set on its own row (`agents.model`, added by AGO-141): Sonnet, Opus or Fable (Haiku is
also on the AGO-141 allowlist). Before this ticket every run used one global `AGENT_MODEL` env value.
Blocked-by AGO-167 (the tool loop) is Done.

| AC | Proof |
|---|---|
| Agent model setting selects the model for every call | `model-routing.test.ts` "uses the agent's model ... for every call across steps" (fake provider records the model id on each of 3 calls, for each allowlisted model); "next run follows a changed model" |
| Unknown model names are rejected at save time | `create-agent.test.ts` "rejects an unknown model name at save time" (creator never called); `agent-schemas.test.ts` (AGO-141, allowlist enum). Run time: `model-routing.test.ts` "unknown models fail the run at start" |
| Tests pass, no regressions, docs updated | `pnpm lint && pnpm typecheck && pnpm test`, this file |

## Implementation details
- `apps/worker/src/agent/model-routing.ts` (new): `ModelRouter.resolve({workspaceId, agentId})` reads the agent's model,
  checks it with `isAgentModelId` from `@ago/shared` (the single allowlist), and returns a provider for that model through a
  `ProviderFactory`. `createPgAgentModelSource` is the Postgres reader (explicit `workspace_id`, composite key).
- `agent-loop.ts`: `AgentLoopDeps` takes either `provider` (one fixed provider, used by existing tests) or `modelRouter`
  (production); exactly one is required. `execute` resolves the provider once at the start of the run, before the first
  step, and every `complete` call of the run uses it.
- `wire.ts`: production uses the router with `createClaudeProvider({ apiKey, model })` as the factory. The key still lives
  only in the provider.
- `config.ts`: the global `AGENT_MODEL` env var is removed (its own comment said it was a stopgap until this ticket).
  An unknown extra env var is ignored, so an old deployment that still sets it keeps booting.

How the guarantees hold:
- The model never comes from the job payload (`runJobSchema` has no model field) or from model output; only from the agent row.
- Unknown, empty or removed model: the run fails at once with `NonRetryableRunError` (`model_not_allowed`), no model call,
  no retries burned, no fallback to another model. A missing agent row fails with `agent_not_found`. Messages are fixed text:
  the stored value is never echoed. A database error while reading is a plain error, so the queue retries it.
- Thinking effort: AGO-141 did not store one, so nothing passes through; it stays with AGO-89.

## Decisions taken
No human was at the keyboard; each recommended option was taken.

| Decision | Choice | Why |
|---|---|---|
| Where routing lives | Behind a `ModelRouter` resolved per run, on top of the existing `ModelProvider` interface | Keeps the vendor seam from AGO-167; the loop and tests stay vendor-free |
| When the model is read | Once at run start (and again on each retry attempt) | A run never mixes models; the owner's change applies to the next run. Documented, tested |
| Unknown model at run time | Fail the run, non-retryable, fixed reason | A retry cannot fix it; a fallback could bill a pricier model |
| DB CHECK on `agents.model` | None | AGO-141 chose to keep the allowlist in code so it can change without a migration; the schema slot belongs to AGO-148. Save-time validation is in the server action (zod enum) |
| Allowlist contents | Left as AGO-141 defined it (Haiku, Sonnet, Opus, Fable) | Single source of truth; Haiku is cheaper, so it adds no cost risk; removing it would strand existing agents |
| Global `AGENT_MODEL` env | Removed | It would be a second, silent source of truth |
| Constructor shape | `provider` or `modelRouter`, exactly one | Avoids rewriting every existing loop test |

## API changes
None over HTTP. Worker internals: `createAgentLoop` accepts `modelRouter`; `AGENT_MODEL` env removed.

## Database changes
None. Read-only `select model from public.agents where workspace_id = $1 and id = $2`.

## Dependencies on other tickets
AGO-167 (tool loop, `ModelProvider`), AGO-141 (`agents.model` and the allowlist). AGO-89 owns thinking effort. AGO-148 holds the schema slot.

## Known limitations
- Agents created before AGO-141 have `model = ''` and now fail their runs with `model_not_allowed` until an owner picks a model.
  There is no edit-agent screen yet, so no save-time path other than create exists; when one is added it must reuse `agentModelSchema`.
- The real Claude provider was not called (it bills). Tests use a fake provider only.

## Testing notes
`pnpm --filter @ago/shared build` first (the worker resolves `@ago/shared` from `dist`), then `pnpm test`.
New: `apps/worker/src/agent/model-routing.test.ts`, two cases in `apps/web/src/features/agents/create-agent.test.ts`.
No live database test was added, so no db lock was needed.

## Follow-up tasks
- Edit-agent flow (changing a model after creation) must validate with `agentModelSchema`.
- Per-model pricing for budget accounting, once budgets (EP-02) land.
