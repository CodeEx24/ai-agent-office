# Testing

| Layer      | Tool                            | Where                        | Command         |
| ---------- | ------------------------------- | ---------------------------- | --------------- |
| Unit       | Vitest + Testing Library        | `apps/*/src/**/*.test.ts(x)` | `pnpm test`     |
| End-to-end | Playwright (`@playwright/test`) | `apps/web/e2e/**/*.spec.ts`  | `pnpm test:e2e` |

Both run in CI (`test` and `test-e2e`). Every user-facing acceptance criterion gets an E2E spec.

## Running E2E locally

```sh
PORT=$(node scripts/free-port.mjs) pnpm test:e2e
```

- Runs `pnpm build`, serves it with `next start` on `PORT` (default 3100), then runs the specs. It tests the production build, not `next dev`. Always set `PORT` from `free-port.mjs`: other ticket worktrees run servers in parallel. The harness never attaches to a server it did not start.
- **Browser.** CI uses Playwright's bundled Chromium. Locally the default is Microsoft Edge (`channel: "msedge"`). Override with `E2E_BROWSER_CHANNEL=chrome`, or `E2E_BROWSER_CHANNEL=` (empty) for bundled Chromium after `pnpm --filter @ago/web exec playwright install chromium`.
- **One-time local setup for failure video:** `pnpm --filter @ago/web exec playwright install ffmpeg` (Edge and Chrome do not ship it; CI gets it with Chromium).
- Debug one spec: build first (`pnpm build`), then `pnpm --filter @ago/web exec playwright test e2e/smoke.spec.ts --headed` with `PORT` set.

## Writing a spec

1. Create `apps/web/e2e/<feature>.spec.ts` (or `apps/web/e2e/<feature>/<name>.spec.ts`).
2. Import `test` and `expect` from the local `fixtures` module, **never** from `@playwright/test`. The shared `test` adds a guard that fails any test whose page logs a console error or throws.
3. Name the test after the criterion: `test("AC1: <criterion>", ...)`. Add at least one negative test per security-relevant criterion (unauthorized user, cross-workspace access, an agent token on a human-only route).
4. Put selectors in a page object under `e2e/pages/` (one file per route, kebab-case file, PascalCase class: `home-page.ts` exports `HomePage`). Assertions stay in the spec.
5. Prefer role and label locators (`getByRole`, `getByLabel`). Use `data-testid` only when there is no accessible name.
6. No `test.only` (CI forbids it) and no fixed sleeps (`waitForTimeout`). Use web-first assertions (`await expect(locator).toBeVisible()`), which retry.
7. Specs must be independent and runnable in parallel. Create the data a test needs inside the test, scoped to its own workspace.

```ts
import { expect, test } from "./fixtures";
import { HomePage } from "./pages/home-page";

test("AC1: the home page shows the product name", async ({ page }) => {
  const home = new HomePage(page);
  await home.goto();
  await expect(home.heading).toBeVisible();
});
```

### Expected console errors

Declare them in the spec, never globally:

```ts
test.use({ allowedConsoleErrors: [/Failed to load resource.*\/api\/flaky/] });
```

### Signed-in tests

Auth state exists (AGO-67). With `E2E_SUPABASE=1` a Playwright `setup` project (`e2e/auth.setup.ts`) signs in once through the real email flow (code read from the local Mailpit catcher) and saves `storageState` to `apps/web/e2e/.auth/user.json` (git-ignored). A spec starts signed in with `test.use({ storageState: AUTH_STATE_PATH })`; `AUTH_STATE_PATH` and `isLiveStack` are exported from `e2e/fixtures/index.ts`. Guard such specs with `test.skip(!isLiveStack, "needs the local Supabase stack")`, because CI has no Supabase stack. Never commit credentials or saved state. How to run the live specs, and how auth works, is in [auth.md](auth.md).

## Failure evidence

`playwright.config.ts` keeps a trace, screenshot and video **only for failing tests** (`trace: "retain-on-failure"`). In CI a failing job uploads `apps/web/test-results/` (traces, screenshots, videos) and `apps/web/playwright-report/` as the `playwright-failure-artifacts` artifact, kept 7 days. Download it from the run page and open a trace with `pnpm --filter @ago/web exec playwright show-trace <trace.zip>` or at https://trace.playwright.dev.

## CI

The `test-e2e` job in `.github/workflows/ci.yml` installs dependencies, restores the Playwright browser cache (keyed on the Playwright version), runs `playwright install --with-deps chromium`, then `pnpm test:e2e`. The job env supplies placeholder public values (`APP_ENV=local`, local URLs) so `next start` boots without secrets. When the app env schema (AGO-70) needs more variables, add placeholders to that `env` block and to `webServer.env` in `playwright.config.ts`.

Bumping Playwright: change the pinned version in `apps/web/package.json` and reinstall; the cache key follows the version.
