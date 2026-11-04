# Tester brief (filled by /run-waves after the implementer's PR, sent as the Orca task spec)

Replace every `{{…}}` before dispatch.

---

**Target:** Jira {{KEY}}, PR #{{PR}}, assigned branch `{{BRANCH}}`, in this worktree. You are the tester. You did not write this feature. Test it the way a user would, then lock that behaviour in with end-to-end tests.

**Change:**
1. **Prove every AC in the running app.** Start the app on a free port (`PORT=$(node scripts/free-port.mjs)`) against the local Supabase stack, then run `/verify-ticket {{KEY}}` with the `playwright` MCP (headless, isolated). Record pass or fail per AC, with screenshots. Watch the console and network for errors. Also try the obvious edge cases for each AC: empty input, wrong role or other workspace (RLS), double submit, timeout means deny.
2. **Write E2E tests** with the `playwright-e2e-builder` skill. Add or extend Playwright specs (in the harness from AGO-118; `pnpm test:e2e`) so every user-facing AC has a spec named after it: `test('AC1: <criterion>', …)`. Include at least one negative test per security-relevant AC (unauthorized user, cross-workspace access, an agent token on a human-only route). Specs live next to the feature's other E2E tests, use the shared fixtures and auth state, and add no `test.only` or fixed sleeps.
3. **Non-UI tickets** (worker, DB, policy): write the equivalent integration tests instead (Vitest against the local stack; RLS tests through `supabase test db`), still one test per AC.
4. **The E2E harness exists** (AGO-118): `pnpm test:e2e` runs Playwright against a production build. Write specs under `apps/web/e2e/`, import `test` and `expect` from its `fixtures` module, and follow `docs/testing.md`. Auth state arrives with AGO-67; until then, signed-in specs are listed in `docs/tickets/{{KEY}}.md` under "Follow-up tasks".
5. Run `PORT=$(node scripts/free-port.mjs) pnpm test:e2e` (or the integration suite) until green. Wrap DB use in `node scripts/db-lock.mjs acquire {{KEY}}-qa` / `release {{KEY}}-qa`.
6. Commit only test files and test fixtures, as `test({{SCOPE}}): cover {{KEY}} acceptance criteria ({{KEY}})`, then `node scripts/as-bot.mjs git push -u origin {{BRANCH}}` (the same branch; never rename it, never force-push). Comment on the PR with the per-AC results table.

**Constraints:** do not change product code. If a test fails because the feature is wrong, that is a finding for the implementer, not something you fix. Never weaken an assertion or skip a test to get to green. Follow CLAUDE.md naming and AGENTS.md rules.

**Ownership:** test files, fixtures and seed data for tests in this worktree, plus PR and Jira comments. Nothing else.

**Observable acceptance:** send `worker_done --outcome succeeded`. The summary's first line is exactly one of:
- `QA: PASS`: every AC verified in the app and covered by a passing test; the new spec files listed;
- `QA: FAIL`: the numbered failing ACs or bugs, each with steps to reproduce, expected vs actual, and a screenshot path;
- `QA: BLOCKED`: what stops testing (missing env value, a broken harness).

Use `--outcome failed` only if you could not run at all.
