# AGO-92 - Create the CI pipeline and dependency alerts

## Overview

Jira AGO-92 (US-012), epic EP-00, wave 1. Adds GitHub Actions for lint, typecheck, test and build, Dependabot version updates, owner routing via `CODEOWNERS`, and `CONTRIBUTING.md` with the Next.js security-update rule. Blocked by AGO-111 (Done). Risk tier: medium (touches CI and supply chain, no data or auth surface). The owner merges this PR because it changes `.github/workflows` and `.github/CODEOWNERS`.

## Implementation details

- `.github/workflows/ci.yml`: on `pull_request` and `push` to `main`; four parallel jobs with stable names `lint`, `typecheck`, `test`, `build`. Each: checkout (`persist-credentials: false`), `pnpm/action-setup` (version taken from `packageManager`, pnpm 10.17.1), `actions/setup-node` Node 24 with `cache: pnpm` (pnpm store cache), `pnpm install --frozen-lockfile`, then the gate. `lint` also runs `pnpm format:check`. `build` runs `pnpm build` (Turbo).
- Hardening: all actions pinned to full SHAs with version comments; `permissions: contents: read`; concurrency group with `cancel-in-progress`; per-job `timeout-minutes`; no `pull_request_target`; no `github.event.*` interpolated into `run:`.
- `ci.yml` has a comment where AGO-118 adds `test-e2e`.
- `.github/dependabot.yml`: npm weekly (minor and patch grouped) and github-actions weekly (grouped), assigned to and reviewed by `@CodeEx24`.
- `.github/CODEOWNERS`: `@CodeEx24` owns manifests, lockfile, workspace file and `.github/`.
- `pr-conventions.yml`: skipped for `dependabot[bot]` (see decisions). `secret-scan.yml` is unchanged.
- `CONTRIBUTING.md`: required checks, workflow rules, dependency alert routing, Next.js rule (PR within 1 working day, merged within 3 days of the release).

## API changes

None.

## Database changes

None.

## Dependencies on other tickets

- AGO-111 (Done): provides the lint, typecheck and test scripts.
- AGO-118 (To Do): adds `test-e2e`; add it to the required checks then.

## Decisions taken (no human at the keyboard; recommended option picked)

| Decision                                              | Chosen                                                               | Why                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| One job per gate vs one job with steps                | One job per gate                                                     | Stable names usable as required checks, parallel, clear failures. Costs 4 installs, served by the store cache.                  |
| pnpm version                                          | From `packageManager` (pnpm 10.17.1), not duplicated in the workflow | Single source of truth; action-setup errors if both are set.                                                                    |
| Dependabot routing                                    | `assignees` + `reviewers` in dependabot.yml and CODEOWNERS           | Both asked for by the coordinator; owner is the only maintainer.                                                                |
| Dependabot PRs vs `pr-conventions` (a required check) | Skip the job when actor is `dependabot[bot]`                         | `dependabot/*` branches can never match the branch regex; a skipped required check counts as passing. Owner retitles on squash. |
| Dependabot alerts                                     | Already enabled (API returns 204); no change                         | Repo setting, human-only.                                                                                                       |
| Branch protection                                     | Not changed; command below                                           | Human-only, guard blocks it.                                                                                                    |
| Turbo remote cache                                    | Not used                                                             | Needs a token or a paid Vercel plan (money = human decision). Revisit if CI gets slow.                                          |

## Branch protection (human-only, run after merge)

Required contexts: `gitleaks`, `pr-conventions`, `lint`, `typecheck`, `test`, `build`; strict (up-to-date) and linear history.

```sh
gh api -X PUT repos/CodeEx24/ai-agent-office/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["gitleaks", "pr-conventions", "lint", "typecheck", "test", "build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Adjust `required_approving_review_count` and `enforce_admins` to how the owner wants to merge (a solo owner cannot approve their own PR).

## Known limitations

- "Must pass to merge" is only enforced once the command above is run.
- No E2E job yet (AGO-118).
- Dependabot PR titles do not follow `type(scope): summary (AGO-n)`; retitle at squash-merge.
- The email path for alerts depends on the owner's GitHub notification settings.

## Testing notes

- Local: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check` (all green).
- `ci.yml`, `dependabot.yml` and `CODEOWNERS` are proven by CI running green on this PR.

## Follow-up tasks

- AGO-118: add the `test-e2e` job and required check.
- Owner: run the branch-protection command.
- Consider a Turbo remote cache if CI time grows.
