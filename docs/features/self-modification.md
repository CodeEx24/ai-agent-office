# Self-modification protection

Only people change an agent's prompt, skills, policies and boot files. An agent that tries gets a **proposal** and nothing changes. (AGO-154, epic EP-17.)

## What is protected

`agent_prompt`, `skill`, `policy` and `boot_file` (`PROTECTED_TARGET_KINDS` in `packages/shared`). A boot file is matched by path only, by `classifyBootPath`: any `_boot` or `.claude` segment, a file named `AGENTS.md`, `CLAUDE.md` or `BOOT.md`, or a path containing `..`. Case and slash style do not matter. Extend the two sets in `self-modification-schemas.ts` when the vault (AGO-121) defines its boot files.

## Two layers

1. **Worker guard** (`apps/worker/src/self-modification/`). Any agent-side write to protected configuration goes through `guardConfigChange(input, { store })`. It validates the input, stores a pending proposal through a `ProposalStore`, and returns `{ outcome: "proposed", proposalId }`. Malformed input or a store failure returns `{ outcome: "denied", reason }`. It has no apply path, never throws, and never returns or logs the proposed content. There is no "human" actor: people use the web app.
2. **Human-only web actions** (`apps/web/src/features/skills/actions.ts`). Create, save, assign and unassign skill actions call `isAgentCredentialRequest()` first and return an error for a request that carries an agent credential (`ago_agt_...`), even with a session cookie. This sits behind the proxy rule from AGO-148 that already refuses agent credentials on every route.

## Not done yet

- Proposals are held in memory (`createInMemoryProposalStore`). The Postgres table, RLS, review UI and approval flow are a follow-up ticket (owner-approved deferral: this ticket made no migration).
- The vault write tool (AGO-121) and the agent edit actions (AGO-89) must call the guard / `isAgentCredentialRequest()` when they land.

## Tests

`packages/shared/src/self-modification/*.test.ts`, `apps/worker/src/self-modification/config-guard.test.ts`, `apps/web/src/features/skills/actions.test.ts`.
