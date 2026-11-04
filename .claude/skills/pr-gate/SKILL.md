---
name: pr-gate
description: >-
  Independent merge gate for Agent Office pull requests. Wait for green CI, run the local gates,
  verify each acceptance criterion, and review the diff through parallel lenses (correctness,
  security/OWASP, project invariants, database/RLS, React/TS, CI and supply chain). Verify every
  finding, post the verdict on the PR, and squash-merge only when everything is clean. Then
  comment the PR link on the Jira ticket and move it to Done. Use for "/pr-gate 12", "gate this
  PR", "review and merge PR #12", "is PR 12 safe to merge", or "/pr-gate --watch" (often under
  /loop) to monitor every open PR. /run-waves dispatches it for each implementer PR.
argument-hint: "<PR number | URL> | --watch"
---

# PR gate

You are the reviewer of record and the only role allowed to merge. You did not write this code. Your job is to find what is wrong, prove it, and merge only what is clean. A false "clean" costs far more than an extra fix round.

Output: one verdict, `MERGED`, `CHANGES_REQUESTED`, `WAITING` or `ESCALATE`. Post it on the PR. When dispatched by `/run-waves`, also make it the first line of `worker_done`.

Fixed facts: repo `CodeEx24/ai-agent-office`, base `main`. Jira cloudId `db54a41b-b837-432b-b361-a2f0b8cfbe7a`. Transitions: `31` In Review, `41` Done.

## Watch mode (`--watch`)

`gh pr list --state open --base main --json number,headRefOid,isDraft,title`. Skip drafts. Skip any PR whose comments already carry `<!-- pr-gate:sha=<headRefOid>` (already gated at this commit) or a `pr-gate:running` marker less than 2 hours old. Gate each remaining PR one at a time with the steps below. End with a table: PR · Ticket · Verdict.

## Steps for one PR

### 1. Identify
- `gh pr view <n> --json number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,files,body,url,statusCheckRollup`
- Post `<!-- pr-gate:running sha=<headRefOid> -->` as a PR comment, so parallel gates and watch mode skip this PR.
- Take the AGO key from the title or branch, then fetch the Jira ticket: summary, description/AC, status, links. No key, a draft, or a base other than `main` → `CHANGES_REQUESTED` with the reason.
- Check out the head: `gh pr checkout <n>`. In an Orca worktree that already holds the branch, `git fetch && git switch <branch> && git pull --ff-only`.

### 2. Human-only changes → ESCALATE
Agents never change their own rules, so the gate never merges a PR that touches any of these:
- `.claude/hooks/**`, `.claude/settings.json`, `.mcp.json`, `.claude/skills/pr-gate/**`, `.claude/skills/run-waves/**`;
- `.github/workflows/**`, `.github/CODEOWNERS`;
- `AGENTS.md`, `CLAUDE.md`, `orca.yaml`, `scripts/worktree-setup.mjs`, `scripts/db-lock.mjs`.

It also escalates PRs that add a paid service or SDK requiring billing, or that change the policy engine's tier table or approval semantics beyond what the ticket's AC asks. Still run the full review and post it. The verdict is `ESCALATE: needs human merge` with the reason, and the human merges.

### 3. CI
- `mergeStateStatus` = `BEHIND`: run `gh pr update-branch <n>`, then wait for CI again.
- `DIRTY`/`CONFLICTING`: `CHANGES_REQUESTED`: "merge main into the branch and resolve conflicts".
- Wait for checks: `gh pr checks <n> --required --watch --interval 30` (cap ~20 min). Still pending → `WAITING`. Any failure: read the log (`gh run view <id> --log-failed`) and return `CHANGES_REQUESTED` with the failing step and the error lines.

### 4. Local gates (on the PR head)
`pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`. Add `pnpm test:e2e` when the diff touches a critical path (auth, approvals, policy, agent runtime, data layer) or the AC asks for it. Use `PORT=$(node scripts/free-port.mjs)`. Wrap DB work in `node scripts/db-lock.mjs acquire <KEY>-gate` … `release <KEY>-gate`, and run `supabase db reset` so migrations apply from scratch. A script that doesn't exist yet is "n/a", not a failure. A red gate → `CHANGES_REQUESTED` with the output.

`pnpm audit --audit-level high`, when a lockfile exists: any high or critical advisory introduced by this PR is blocking.

### 5. Acceptance criteria
List every AC from the Jira ticket and find the evidence for each: a test that asserts it, a command output, or a browser check. For anything user-facing, run `/verify-ticket <KEY>` against the PR head (dev server on a free port, `playwright` MCP). An AC with no evidence is blocking.

### 6. Review lenses (run in parallel as subagents)
Always:
- the user skill `senior-pr-reviewer` on this PR, in review-only mode (correctness, architecture, tests, ops);
- `ago-invariants-reviewer` (project agent): the AGENTS.md non-negotiables;
- `ecc:security-reviewer`: OWASP Top 10, authz/IDOR, injection, SSRF, XSS, secrets, unsafe crypto, prompt-injection paths.

Only when the diff touches the area:

| Diff touches | Add |
|---|---|
| `supabase/**`, `*.sql`, data layer | `ecc:database-reviewer` + `supabase-schema-architect`. Run `/supabase-security-audit --rls` against the local stack |
| `*.ts`, `*.tsx` | `ecc:typescript-reviewer`; `ecc:react-reviewer` for `*.tsx` |
| `package.json`, `pnpm-lock.yaml` | `supply-chain-security`: new deps, typosquats, install scripts, licenses |
| `.github/workflows/**` | `github-actions-expert`: pinning, permissions, injection |
| 3D scene / `features/office/**` | `ecc:performance-optimizer` (non-blocking unless the AC has a perf budget) |

Give each subagent the PR number, the ticket's AC and this instruction: "report only verified findings with file:line and a concrete failure scenario."

### 7. Verify, then decide
Re-check every blocking finding yourself in the code. Drop anything you cannot reproduce or point to, and move unsure ones to "Unverified" (non-blocking). Deduplicate across lenses.

**Blocking:** a verified correctness bug; any security vulnerability; any invariant violation; a red CI or local gate; an unmet AC; missing tests that the AC or the invariants require (policy, approval, RLS); an irreversible migration; a secret anywhere in the diff.
**Non-blocking:** style, naming nits, refactors and suggestions. Post them, but they don't hold the merge.

Trivial mechanical fixes (a lint autofix, a typo in a comment) may be pushed by the gate as a separate commit. Re-run step 4 after doing so. Anything more goes back to the implementer.

### 8. Post the review
`gh pr review <n> --comment --body-file <file>`. GitHub does not let the author's own account approve, so the verdict lives in this comment. The body:
```
<!-- pr-gate:sha=<headRefOid> verdict=<VERDICT> -->
## PR gate: <VERDICT>
CI: … · Local gates: lint ✓ typecheck ✓ test ✓ e2e n/a · Audit: …
### Acceptance criteria
| AC | Evidence | Result |
### Blocking (must fix)
1. file:line: problem → failure scenario → suggested fix
### Suggestions (non-blocking)
### Lenses run
```
Add inline comments for blocking findings with `gh api repos/CodeEx24/ai-agent-office/pulls/<n>/comments` (path, line, commit_id = head SHA).

### 9. Merge and close out (only when the verdict is clean)
Re-read `gh pr view <n> --json headRefOid,mergeStateStatus` and confirm the head SHA is still the one you reviewed and the state is `CLEAN`. If it moved, start again from step 3.

Then follow the user skill `merge-ticket` for this PR and ticket. The user has pre-authorized squash merges of gate-clean PRs, so don't stop for confirmation.
- Merge: `gh pr merge <n> --squash --delete-branch --subject "<PR title> (#<n>)"`. Never use `--admin`.
- Confirm `state = MERGED` and get the merge commit SHA.
- Jira comment (idempotent: skip it if a comment already contains the PR URL):
  `Merged in <PR URL> (squash <short SHA>). Gate: CI ✓, lint/typecheck/test ✓, AC n/n ✓, security review clean. <one-line summary>`
- Transition the ticket to **Done** (`41`).
- Release any DB lock you hold.

Verdict: `MERGED`.

## Never
- Merge with any blocking finding, a red or pending required check, or an unreviewed head SHA.
- Merge a human-only PR (step 2).
- Approve, dismiss reviews, or change branch protection.
- Mark Jira Done before the merge is confirmed.
