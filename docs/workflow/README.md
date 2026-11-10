# Delivery workflow - Agent Office

PM project: Agent Office, Jira <https://stratyge.atlassian.net> · Key: `AGO` · Main branch: `main`

This project follows the AI delivery workflow (`~/.claude/workflows/ai-delivery-workflow.md`, imported from `CLAUDE.md`). This file holds the project's own values; where it is silent, the workflow's defaults apply. Review rules: [REVIEW.md](REVIEW.md). Naming (branch, commit, PR, migration) is CLAUDE.md §5 and is not repeated here.

Start the loop with `/loop /deliver AGO` (see the workflow file's Quick start for `--status`, `--dry-run`, `--cap`).

## Statuses

Jira statuses: To Do → In Progress → In Review → Done. `/implement-ticket` moves a ticket to In Progress and, with the draft PR, to In Review. Only `/merge-ticket` moves it to Done.

## Capacity

- **Concurrency cap: 3** tickets in flight at once (owner decision, 2026-11-10).
- **Device lane:** one local web app plus one Playwright run at a time. The browser checks use the shared local Supabase stack, so the lane holder also holds the db lock (`node scripts/db-lock.mjs acquire AGO-<n>` … `release AGO-<n>`). Start dev servers on a free port (`PORT=$(node scripts/free-port.mjs)`), never on a fixed 3000. A ticket waiting for the lane also waits for its UI / UX reviewers. Recipe: [../setup/local-backend.md](../setup/local-backend.md). There is no native app, so no dev build registry.
- **Schema slot:** only one schema-changing ticket is in flight at a time (CLAUDE.md §5). The orchestrator hands the slot out; a worker that needs a migration asks for it.

## Merge path

Merge path: **agent merges (allowed by owner, 2026-11-10)**. `/merge-ticket` marks the PR ready, re-syncs and re-gates, squash-merges, then closes the ticket.

- The owner adds the `gh pr merge` allow rule to `.claude/settings.json` themselves (agents never edit settings). Until it is there, treat the path as "owner merges": the ticket gets `ready-to-merge` and the owner clicks.
- PRs that change agent rules or tooling (`.claude/`, `.github/workflows/`, `AGENTS.md`, `CLAUDE.md`, `orca.yaml`, `scripts/`) are human-merge paths: the approver ESCALATEs them to the owner even when the gate is green.
- Worker push policy: workers may push their own ticket branch and open **draft** PRs; nothing merges without the gates. Commits, pushes and PRs go through `node scripts/as-bot.mjs`.
- Tickets already in flight when `/deliver` was adopted (AGO-166, AGO-94, AGO-136, AGO-25) finish on the legacy `/run-waves` + `/pr-gate` process. New tickets start under `/deliver`.

## Ticket type mapping

| Jira issue type | Workflow type |
|---|---|
| Story | Feature |
| Bug | Bug |
| Task | Chore |
| Spike (label `type:spike`) | Spike |

A `type:<name>` label wins over the issue type. Critical bugs carry `severity:critical`.

## Scripts

- **Checks:** `scripts/workflow/checks.sh` / `checks.ps1`. `--report <path>` (`-Report` in PowerShell) writes the round file (first line `VERDICT: PASS` or `VERDICT: FAIL`, then each command and the log tail); without it the script only prints the result and exit code. Runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, pgTAP (`pnpm exec supabase test db`, under the db lock, only when the local stack is up; otherwise skipped with a note) and the ticket record check (`docs/tickets/<KEY>.md` exists, and has a link block once a PR exists; the key comes from the branch name).
- **Cost:** `node scripts/workflow/cost AGO-<n>` sums the usage in the Claude Code transcripts of the ticket's worktree (`~/.claude/projects/*ago-<n>-*`, subagents included), prices it and prints the total; prints `cost: not tracked` when none are found. Posted on the PR and the ticket at merge.

## Risk tiers

| Risk | When | Extra gates |
|---|---|---|
| Low | Small change, none of the High areas, no behaviour change in a sensitive path (docs, tooling, copy) | - |
| Medium | Everything else | Security reviewer if a security surface is touched |
| High | Auth; RLS and data access; AI / prompt surfaces; credentials and secrets; budgets and quotas; migrations | Security reviewer always; pgTAP database tests + rollback check |

Risk is separate from type: a small bug in auth is still High.

## Where things go

- Ticket records: `docs/tickets/AGO-<n>.md` (template `_TEMPLATE.md`; links block first: ticket, every PR, related tickets).
- Owner setup steps: `docs/actions/<name>.md` (front matter; `docs/actions/README.md` is generated).
- Environment recipes: [../setup/local-backend.md](../setup/local-backend.md).
- Feature guides: `docs/features/<area>.md`.
- Wave plan: `docs/waves/wave-plan.md`.
- Working state: `.delivery/` (gitignored).
- Labels: `needs-human`, `ready-to-merge`, `wave-N`, `type:<name>`, `severity:critical`.
