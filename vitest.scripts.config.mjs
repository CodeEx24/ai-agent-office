import { defineConfig } from "vitest/config";

// Repo-level tests that are not part of a workspace package (scripts/). Run by `pnpm test`
// after `turbo run test`, so `packages/shared/dist` exists. The AGO-70 acceptance tests also
// start the web app, hence the long timeout.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
    // The DB suites share one local Postgres (run inside scripts/db-lock.mjs). With RUN_DB_TESTS=1 the
    // files run one at a time so db-seed-qa never overlaps the run_events suites (AGO-201).
    fileParallelism: process.env.RUN_DB_TESTS !== "1",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
