# Implementer brief (filled by /run-waves, sent as the Orca task spec)

Replace every `{{…}}` before dispatch. Keep the rest verbatim.

---

**Target:** Jira ticket {{KEY}}, "{{SUMMARY}}" (wave {{WAVE}}), in this worktree only.

**Change:** Run `/implement-ticket {{KEY}}` end to end and open a PR. Do not merge.

**Constraints:**
1. **Assigned names. Use them exactly and never invent or change them.**
   - Branch `{{BRANCH}}`.
   - PR title and every commit: `{{TYPE}}({{SCOPE}}): <summary> ({{KEY}})`. `{{SCOPE}}` is the main scope; another scope from CLAUDE.md §5 is fine for an individual commit.
   - Orca created this worktree on a branch named after the worktree. **Before your first commit**, run `git branch -m {{BRANCH}}`. Never rename after the first push. Fix rounds push to this same branch, and one ticket gets exactly one branch and one PR.
   - Migrations are named `<timestamp>_ago_{{NUMBER}}_<what>.sql`, and ticket notes go in `docs/tickets/{{KEY}}.md`.
   - Use the key unpadded, always: `{{KEY}}` / `ago-{{NUMBER}}`.
1a. **Schema slot: {{SCHEMA}}.** If "no" and you find you need a migration or any DB schema change, `ask` the coordinator for the schema slot before writing it. On "wait", finish the non-schema parts first.
2. **No human at the keyboard.** Wherever `/implement-ticket` would stop for the human's choice (the decision checkpoint, the plan approval, ambiguous AC), pick the **recommended** option yourself. Record each decision and its reason in `docs/tickets/{{KEY}}.md` and in the PR's "Decisions taken" section, then keep going.
3. **Ask the coordinator** with the `ask` command from your Orca preamble, never a local prompt, and only for:
   - anything that costs money: paid plans, upgrades, purchases, paid APIs or credits, anything that bills;
   - a secret or credential you don't have;
   - hosted Supabase or cloud changes;
   - an AC that contradicts CLAUDE.md or AGENTS.md;
   - a locked-stack change.
   Give the options with the recommended one first, then wait for the reply.
4. **Rules.** Follow `CLAUDE.md` and `AGENTS.md`: naming, folder structure, invariants and reuse-first. Load the best-practice skills the work touches (`vercel-react-best-practices`, `supabase`, `supabase-postgres-best-practices`, `nextjs-supabase-auth`, `playwright-e2e-builder`, `vercel-composition-patterns`).
5. **Database.** Use only the shared local Supabase stack in Docker (see the `local-db` skill). Wrap every `supabase db reset` and every DB test run in `node scripts/db-lock.mjs acquire {{KEY}}` … `node scripts/db-lock.mjs release {{KEY}}`. Never link or push to a hosted project. Migrations must be reversible, and every table needs `workspace_id` + RLS.
6. **Ports.** Start the dev server with `PORT=$(node scripts/free-port.mjs)`, never on a hard-coded 3000. Other tickets run in parallel.
7. **Browser checks.** Use the `playwright` MCP (headless, isolated). Claude-in-Chrome is shared by all workers.
8. **Gates before the PR:** `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:e2e` when the ticket touches a critical path. Skip any gate whose script doesn't exist yet, and say so in the PR.
9. **Commit, push and PR as the bot.** Prefix with `node scripts/as-bot.mjs`:
   - `node scripts/as-bot.mjs git commit -m "…"`;
   - `node scripts/as-bot.mjs git push -u origin {{BRANCH}}`;
   - `node scripts/as-bot.mjs gh pr create --base main --head {{BRANCH}} --title "…" --body-file …`.

   It falls back to the user's account when no bot is configured. Fill in every `.github/pull_request_template.md` section and restate every AC with how it is proven. Never review or approve PRs; that is the gate's job.
10. **Jira.** You may comment on {{KEY}}. Leave status transitions to the coordinator.
11. **Hooks.** If a guard hook denies something, don't work around it. Ask the coordinator.

**Ownership:** you may edit only this worktree and the {{KEY}} branch. Don't touch other tickets' branches or worktrees, `main`, or repo settings.

**Observable acceptance:** an open PR against `main` whose title ends in `({{KEY}})`, with green local gates and a filled `docs/tickets/{{KEY}}.md`. Send `worker_done --outcome succeeded` with the PR URL as the first line of the summary. If you cannot finish, send `--outcome failed` with the blocker in one sentence.

**Fix rounds:** if you later receive a fix task for this PR, push new commits to the same branch (never force-push), re-run the gates, reply on the PR to each finding, then send `worker_done` again.
