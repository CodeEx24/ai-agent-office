import { describe, expect, it } from "vitest";

import { loadWorkerEnv } from "./env.js";

describe("loadWorkerEnv", () => {
  it("fails when NODE_ENV=production and APP_ENV is unset, naming APP_ENV", () => {
    expect(() => loadWorkerEnv({ NODE_ENV: "production", DATABASE_URL: "x" })).toThrow(/APP_ENV/);
  });

  it("defaults to local when NODE_ENV is development or test", () => {
    expect(loadWorkerEnv({ NODE_ENV: "development" }).APP_ENV).toBe("local");
    expect(loadWorkerEnv({ NODE_ENV: "test" }).APP_ENV).toBe("local");
  });

  it("accepts a production build with APP_ENV=local", () => {
    expect(loadWorkerEnv({ NODE_ENV: "production", APP_ENV: "local" }).APP_ENV).toBe("local");
  });
});
