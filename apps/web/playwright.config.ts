import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build served by `next start` (the "preview build"), never `next dev`.
// `pnpm test:e2e` builds first (see turbo.json). The port comes from PORT so parallel worktrees
// never collide: PORT=$(node scripts/free-port.mjs) pnpm test:e2e
const isCI = Boolean(process.env.CI);
const port = String(Number(process.env.PORT ?? 3100));
const baseURL = `http://127.0.0.1:${port}`;

// CI uses Playwright's bundled Chromium. Locally the default is Microsoft Edge (Chrome is not
// installed on the Windows dev machine). Override with E2E_BROWSER_CHANNEL (e.g. `chrome`),
// or set it to an empty string to use bundled Chromium after `playwright install chromium`.
const channel = process.env.E2E_BROWSER_CHANNEL ?? (isCI ? "" : "msedge");

// Specs that need a real Auth server and mail catcher (email sign-in, sessions, sign-out) run only
// with the shared local Supabase stack up. Run them with:
//   E2E_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... pnpm test:e2e
// (URL and anon key from `pnpm exec supabase status`; local demo keys only, never committed.)
const isLiveStack = process.env.E2E_SUPABASE === "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    // Failure evidence only: kept when a test fails, discarded when it passes.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Signs in once through the real email flow and saves the session (e2e/.auth/, git-ignored)
    // for specs that start signed in. Needs the local Supabase stack, so it only exists when
    // E2E_SUPABASE=1 (CI has no stack and runs the stack-free specs only).
    ...(isLiveStack
      ? [
          {
            name: "setup",
            testMatch: /auth\.setup\.ts/,
            use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) },
          },
        ]
      : []),
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/,
      dependencies: isLiveStack ? ["setup"] : [],
      use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    // Never attach to a server we did not start: it may belong to another ticket's worktree.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Minimal safe env so the production server boots (no secrets; placeholder public URLs).
      APP_ENV: "local",
      NEXT_PUBLIC_APP_URL: baseURL,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55421",
      // Placeholder unless a live stack is used: stack-free specs never reach Supabase.
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key-no-stack",
    },
  },
});
