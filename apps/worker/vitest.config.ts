import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // The integration tests share one pg-boss queue ("agent-run") and purge it between tests, so two
    // test files must never run at the same time.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
