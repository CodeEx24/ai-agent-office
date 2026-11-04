# AI delivery workflow

How AGO tickets go from Jira to `main` with AI agents doing the work and a human in the loop for anything that costs money or changes the rules.

```
/plan-waves ──► Jira labels wave-N + Blocks links (human approves the plan)
     │
/run-waves (coordinator, main checkout)
     │  for each ready ticket in the current wave (max 3 in parallel)
     ├─► Jira: In Progress
     ├─► Orca worktree ago-<n>-<slug>  ──► implementer: /implement-ticket AGO-<n>
     │                                      branch <type>/ago-<n>/<slug>, gates, PR
     ├─► Jira: In Review
     ├─► same worktree, fresh agent    ──► gatekeeper: /pr-gate <PR>
     │        CI ✓ · local gates ✓ · AC evidence ✓ · review lenses ✓ (verified findings only)
     │        ├─ clean        → squash merge → Jira comment with PR link → Done
     │        ├─ findings     → back to implementer (max 3 fix rounds) → gate again
     │        └─ human-only   → escalate to you
     └─► wave done → close finished epics → /wave-status cross-check → next wave
```

## Commands

| Command | What it does |
|---|---|
| `/plan-waves` | Orders the backlog into waves by dependency and priority. Changes Jira only after you approve. |
| `/run-waves [wave-N] [--max-parallel N] [--one-wave] [--dry-run]` | Runs the loop above. Resumes in-flight tickets after a break. |
| `/pr-gate <PR>` | Gates one PR: review, security, AC, merge, Jira close-out. |
| `/loop 15m /pr-gate --watch` | Monitors every open PR, including ones opened by hand. |
| `/wave-status` | Read-only: where are we, what is out of sync, what is next. |
| `/implement-ticket AGO-###` | One ticket by hand, interactive, in the current checkout. |
| `/local-db` | Local Supabase in Docker: start, reset, lock, types, RLS tests. |

## What always comes back to you
- Anything that costs money: paid plans, upgrades, purchases, paid API credits, anything that bills.
- Secrets and credentials only you have, and the `.env.local` values.
- Hosted Supabase, Vercel or cloud changes.
- PRs that change the agents' own rules or tooling: `.claude/hooks`, `.claude/settings.json`, `.mcp.json`, the `run-waves`/`pr-gate` skills, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `orca.yaml`, the setup scripts. The gate reviews them, and you merge.
- An AC that contradicts CLAUDE.md/AGENTS.md, or a locked-stack change (ADR).
- A ticket that fails twice, or a PR that is still not clean after 3 fix rounds.

Every other decision is made by the agent, which picks the recommended option and records it in `docs/tickets/AGO-###.md` and in the PR's "Decisions taken" section.

## Guardrails
- **Hook** `.claude/hooks/guard.mjs` (PreToolUse) blocks: force pushes, pushes to `main`, non-squash or `--admin` merges, `--no-verify`, remote Supabase commands, repo deletion or visibility changes, branch-protection edits, writes to `.env*`, and commits whose staged diff contains a secret.
- **Permissions** in `.claude/settings.json` stop agents reading `.env`, `.env.local`, `.env.test` and other secret files. `.env.example` stays readable.
- **GitHub**: public repo, squash-only, branches auto-deleted after merge, secret scanning with push protection, Dependabot alerts. `main` is protected: PR required, `gitleaks` + `pr-conventions` checks required, branch up to date, linear history, no force pushes.
- **CI**: `secret-scan.yml` (gitleaks) and `pr-conventions.yml` (branch and title format). The build/test pipeline comes with AGO-92, so add its jobs to the required checks then.

## Parallel worktrees
- Each new worktree runs `orca.yaml` → `scripts/worktree-setup.mjs`, which copies your untracked `.env*` files from the main checkout and runs `pnpm install`.
- Dev servers use `PORT=$(node scripts/free-port.mjs)`. Browser checks use the `playwright` MCP (headless, isolated), because Claude-in-Chrome is shared.
- There is one local Supabase stack, and schema changes and DB tests go through `scripts/db-lock.mjs`. See the `local-db` skill.

## Installed components
| Kind | Name | Source |
|---|---|---|
| Skills | `run-waves`, `pr-gate`, `local-db` | this repo |
| Skills | `vercel-react-best-practices`, `vercel-composition-patterns`, `vercel-react-view-transitions`, `web-design-guidelines`, `writing-guidelines` | `npx skills add vercel-labs/agent-skills` (CLAUDE.md §6) |
| Skills | `supabase`, `supabase-postgres-best-practices` | `npx skills add supabase/agent-skills` (CLAUDE.md §6) |
| Skills | `nextjs-supabase-auth`, `playwright-e2e-builder` | aitmpl.com |
| Agents | `ago-invariants-reviewer` | this repo |
| Agents | `supabase-schema-architect`, `supply-chain-security`, `github-actions-expert` | aitmpl.com |
| Commands | `/supabase-security-audit`, `/supabase-migration-assistant`, `/supabase-type-generator`, `/dependency-audit` | aitmpl.com |
| Settings | deny reads of secret files (extended from aitmpl `permissions/deny-sensitive-files`) | aitmpl.com + this repo |
| Hooks | `guard.mjs` | this repo (aitmpl's force-push and secret-scanner hooks were rejected: false positives on `fix/` branches, and a `python3` dependency that doesn't run on Windows) |
| MCP | `playwright` (`@playwright/mcp@0.0.84`), `supabase-local` | npm / Supabase CLI |
| User-level, reused | `implement-ticket`, `merge-ticket`, `plan-waves`, `wave-status`, `verify-ticket`, `senior-pr-reviewer`, `setup-env`, `orchestration`, `orca-cli`, ECC reviewers | `~/.claude` |

`skills-lock.json` pins the skill packs. Update them with `npx skills update -p`, and review the diff before committing.

## One-time setup (human)
1. Orca running, `gh auth status` OK, and the Atlassian connector authorized in Claude Code.
2. Docker Desktop running (≥ 4 GB memory for Supabase).
3. After AGO-70 lands: fill `.env.local` in the main checkout from `.env.example`. New worktrees copy it.
4. Allow Jira writes for the agents (comments and transitions) in Claude Code permissions. Otherwise the auto-mode classifier asks on every Jira write.
