import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { bootstrapWorker } from "./main.js";

describe("bootstrapWorker", () => {
  it("returns null and writes one fatal JSON line naming the variable on a failed env check", async () => {
    const lines: string[] = [];
    const worker = await bootstrapWorker(
      { NODE_ENV: "production", DATABASE_URL: "postgres://u:s3cret@h/db" },
      (line) => lines.push(line),
    );
    expect(worker).toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "fatal", service: "worker" });
    expect(lines[0]).toContain("APP_ENV");
    expect(lines[0]).not.toContain("s3cret");
  });

  it("returns null on an invalid WORKER_PORT", async () => {
    const lines: string[] = [];
    const worker = await bootstrapWorker({ NODE_ENV: "test", WORKER_PORT: "nope" }, (line) =>
      lines.push(line),
    );
    expect(worker).toBeNull();
    expect(lines[0]).toContain("WORKER_PORT");
  });

  it("starts, serves /health (db unreachable -> 503) and stops", async () => {
    const worker = await bootstrapWorker(
      {
        NODE_ENV: "test",
        WORKER_PORT: "0",
        LOG_LEVEL: "silent",
        DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
        HEALTH_DB_TIMEOUT_MS: "300",
      },
      () => undefined,
    );
    expect(worker).not.toBeNull();
    try {
      const port = (worker?.server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "down", db: { status: "down" } });
    } finally {
      await worker?.stop();
    }
  });
});
