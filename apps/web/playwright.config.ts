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
    {
      name: "chromium",
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
      // The dev-only 3D test page is off in production builds unless this is set (AGO-49).
      ENABLE_DEV_3D: "1",
      NEXT_PUBLIC_APP_URL: baseURL,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    },
  },
});
