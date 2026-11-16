import { defineConfig } from "vitest/config";

// Repo-level tests that are not part of a workspace package (scripts/). Run by `pnpm test`
// after `turbo run test`, so `packages/shared/dist` exists. The AGO-70 acceptance tests also
// start the web app, hence the long timeout.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
    // The DB suites share one local Postgres (run inside scripts/db-lock.mjs) with ~97 usable connection
    // slots. The AGO-151 suites alone can open that many at once (10 workers x up to 12 connections, 6
    // enqueuers), so files always run one at a time: parallel files starved each other of slots
    // ("remaining connection slots are reserved", AGO-212) and db-seed-qa overlapped the run_events
    // suites (AGO-201).
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
