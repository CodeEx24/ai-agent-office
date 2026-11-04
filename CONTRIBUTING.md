# Contributing to Agent Office

Read `CLAUDE.md` first (stack, folder structure, naming, invariants). This file covers the day-to-day contribution rules that are not in it.

## Workflow

- One Jira ticket, one branch, one PR. Branch `<type>/ago-<n>/<slug>`; PR title `type(scope): summary (AGO-<n>)`. See `CLAUDE.md` section 5; the `pr-conventions` check enforces it.
- Ticket notes live in `docs/tickets/AGO-<n>.md`.
- Squash-merge only, with a linear history on `main`.

## Checks that must pass to merge

Every PR runs these GitHub Actions checks. They are the required status checks on `main`:

| Check | What it runs |
|---|---|
| `gitleaks` | Secret scan (`secret-scan.yml`) |
| `pr-conventions` | Branch name and PR title format |
| `lint` | `pnpm lint` and `pnpm format:check` |
| `typecheck` | `pnpm typecheck` |
| `test` | `pnpm test` |
| `build` | `pnpm build` (Turborepo) |

Run `pnpm lint && pnpm typecheck && pnpm test` locally before pushing. The E2E job (`test-e2e`) is added with the Playwright harness (AGO-118) and becomes required then.

Changes to `.github/` (workflows, `CODEOWNERS`, `dependabot.yml`), `package.json` and `pnpm-lock.yaml` are owner-reviewed through `CODEOWNERS`.

### Workflow rules

- Pin every action to a full commit SHA with a version comment (`# v1.2.3`). Dependabot keeps them current.
- Keep `permissions: contents: read` at the top of a workflow and widen it per job only when needed.
- Use `persist-credentials: false` on checkout. Never use `pull_request_target`.
- PR titles, branch names and other `github.event.*` values are untrusted. Pass them through `env:`, never interpolate them into `run:` scripts.

## Dependency alerts

- **Dependabot alerts** (security advisories) are enabled for the repository. GitHub notifies the owner (`@CodeEx24`) by email and in the GitHub notification inbox. The owner keeps Settings > Notifications > "Dependabot alerts" on.
- **Dependabot version updates** (`.github/dependabot.yml`) open weekly PRs for npm (grouped minor and patch updates) and GitHub Actions, assigned to and reviewed by the owner.
- Security PRs and alerts are triaged by severity: critical and high within 3 days, medium and low in the next regular dependency update.

## Next.js security releases: upgrade within 3 days

Next.js sits on the request path of the whole app, so a security release is never left to the weekly cycle.

1. When a Next.js security advisory or release is published (Dependabot alert, the Next.js blog or the GitHub advisory feed), open a ticket and a PR **within 1 working day**.
2. Upgrade `next` (and `eslint-config-next`, kept on the same version) to the patched release. `CLAUDE.md` pins Next.js 16.4.1+; never stay below the patched version.
3. The upgrade PR **merges within 3 days of the release** once CI is green. If it is blocked, the owner decides on a mitigation and records it in the ticket.
4. Do not bundle other work into the upgrade PR.
