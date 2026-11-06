import { describe, expect, it } from "vitest";

import { LOCAL_DATABASE_URL, loadWorkerConfig } from "./config.js";

describe("loadWorkerConfig", () => {
  it("uses safe local defaults", () => {
    const config = loadWorkerConfig({ NODE_ENV: "development" });
    expect(config).toMatchObject({
      port: 8787,
      host: "127.0.0.1",
      logLevel: "info",
      databaseUrl: LOCAL_DATABASE_URL,
    });
  });

  it("reads overrides, treating empty strings as unset", () => {
    const config = loadWorkerConfig({
      NODE_ENV: "test",
      WORKER_PORT: "9100",
      LOG_LEVEL: "debug",
      WORKER_HOST: "",
    });
    expect(config.port).toBe(9100);
    expect(config.logLevel).toBe("debug");
    expect(config.host).toBe("127.0.0.1");
  });

  it("rejects a bad port and names the variable, not its value", () => {
    expect(() => loadWorkerConfig({ NODE_ENV: "test", WORKER_PORT: "99999" })).toThrow(
      /WORKER_PORT/,
    );
    expect(() => loadWorkerConfig({ NODE_ENV: "test", LOG_LEVEL: "loud-sekret" })).not.toThrow(
      /loud-sekret/,
    );
  });

  it("fails when the shared env check fails (production without APP_ENV)", () => {
    expect(() => loadWorkerConfig({ NODE_ENV: "production" })).toThrow(/APP_ENV/);
  });
});
