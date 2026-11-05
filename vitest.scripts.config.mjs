import { defineConfig } from "vitest/config";

// Repo-level tests that are not part of a workspace package (scripts/). Run by `pnpm test`
// after `turbo run test`, so `packages/shared/dist` exists. The AGO-70 acceptance tests also
// start the web app, hence the long timeout.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
