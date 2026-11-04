# AGO-1 - EP-00 Project setup: AI delivery workflow slice

## Overview
Sets up the tooling that lets AI agents deliver AGO tickets end to end with a human in the loop: wave orchestration, one Orca worktree per ticket, an independent review-and-merge gate, local Supabase in Docker, guard hooks and repo hygiene. It lands under epic AGO-1 (EP-00 Project setup), wave 1. The app scaffold (AGO-57), env config (AGO-70) and CI pipeline (AGO-92) stay with their own tickets.

## Implementation details
- `.claude/skills/run-waves`: coordinator. It reads `wave-N` labels and Blocks links, dispatches implementers through `orca orchestration worker-start --worktree new-top-level`, routes PRs to the gate, handles fix rounds and escalates human-only decisions.
- `.claude/skills/pr-gate`: CI wait, local gates, AC evidence and parallel review lenses, then verified findings, a PR comment, a squash merge, and the Jira comment plus Done. Reuses the user skills `senior-pr-reviewer`, `verify-ticket` and `merge-ticket`.
- `.claude/skills/local-db`, `scripts/db-lock.mjs`: one shared local Supabase stack, with schema resets serialized across worktrees.
- `.claude/hooks/guard.mjs`: PreToolUse guard (see `docs/ai-workflow.md`).
- `orca.yaml` + `scripts/worktree-setup.mjs`: env copy and `pnpm install` in each new worktree. `scripts/free-port.mjs` gives parallel dev servers their own ports.
- From aitmpl.com and the skill registries: see the table in `docs/ai-workflow.md`.
- The AGENTS.md merge rule is narrowed: only `/pr-gate` merges, and humans merge rule/tooling PRs.

## API changes
None.

## Database changes
None. The DB workflow is documented only, and the stack arrives with the scaffold tickets.

## Dependencies on other tickets
- AGO-57 (monorepo): adds `supabase` as a root dev dependency. `pnpm` gates start applying then.
- AGO-70 (env config): `.env.example`. The human fills `.env.local` once, and worktrees copy it.
- AGO-92 (CI): add its build/test jobs to `main`'s required checks.

## Known limitations
- The guard hook tokenizes shell commands heuristically. It is defense in depth, not a sandbox.
- `.mcp.json` launches Playwright with `cmd /c` (Windows). Non-Windows contributors need `npx` directly.
- The same GitHub account opens and gates PRs, so the gate's verdict is a review comment, not a GitHub approval.
- A Jira story for this slice couldn't be created from the agent session (permission denied), so the branch references the epic.

## Testing notes
- `guard.mjs`: 19 allow/deny command cases plus a staged-secret commit case, run locally (all pass).
- `db-lock.mjs`: acquire, contention timeout (exit 2), wrong-owner release refused (exit 1), release.
- `free-port.mjs` and `worktree-setup.mjs`: run in the main checkout.
- CI: `gitleaks` and `pr-conventions` run on this PR.

## Follow-up tasks
- After AGO-92: add its jobs to the required status checks.
- Optional: CodeQL default setup once JS/TS code exists. It is free for public repos.
