# Gatekeeper brief (filled by /run-waves, sent as the Orca task spec)

Replace every `{{…}}` before dispatch.

---

**Target:** PR #{{PR}} ({{PR_URL}}) for Jira {{KEY}}. Check out its head branch in this worktree.

**Change:** Run `/pr-gate {{PR}}`. You are an independent reviewer. You did not write this code, so don't trust the PR description; verify it.

**Constraints:** follow `/pr-gate` exactly. You may push only trivial, mechanical fixes. Anything else goes back as CHANGES_REQUESTED. Merge only when every gate condition holds. Never use `--admin`. Wrap DB use in `node scripts/db-lock.mjs acquire {{KEY}}-gate` / `release {{KEY}}-gate`.

**Ownership:** read the whole repo. You may comment on the PR and on Jira {{KEY}}, merge PR #{{PR}} when it is clean, and transition {{KEY}} to Done after the merge. Nothing else.

**Observable acceptance:** send `worker_done --outcome succeeded`. The summary's first line is exactly one of:
- `VERDICT: MERGED`, followed by the merge commit SHA and confirmation that the Jira comment and Done transition happened;
- `VERDICT: CHANGES_REQUESTED`, followed by the numbered blocking findings with `file:line`;
- `VERDICT: WAITING`, followed by what is pending (CI still running, GitHub not mergeable yet);
- `VERDICT: ESCALATE`, followed by the human-only reason.

Use `--outcome failed` only if the gate itself could not run (tooling broken); give the reason.
