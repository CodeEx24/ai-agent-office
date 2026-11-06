import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHealthReport,
  httpStatusFor,
  queueNotConfigured,
  type HealthCheck,
} from "./health.js";
import { createLogger } from "./logger.js";
import { startHealthServer } from "./server.js";

import type { Server } from "node:http";

const up: HealthCheck = () => Promise.resolve({ status: "ok" });
const down: HealthCheck = () => Promise.resolve({ status: "down" });
const throws: HealthCheck = () => Promise.reject(new Error("boom"));

describe("buildHealthReport", () => {
  it("is degraded (200) when the db is up and the queue is not configured", async () => {
    const report = await buildHealthReport({ db: up, queue: queueNotConfigured }, 3.4);
    expect(report).toEqual({
      status: "degraded",
      db: { status: "ok" },
      queue: { status: "not_configured" },
      uptime_s: 3,
    });
    expect(httpStatusFor(report)).toBe(200);
  });

  it("is ok when db and queue are both up", async () => {
    const report = await buildHealthReport({ db: up, queue: up }, 0);
    expect(report.status).toBe("ok");
  });

  it("is down (503) when the db is down, whatever the queue says", async () => {
    const report = await buildHealthReport({ db: down, queue: up }, 0);
    expect(report.status).toBe("down");
    expect(httpStatusFor(report)).toBe(503);
  });

  it("treats a throwing probe as down", async () => {
    const report = await buildHealthReport({ db: throws, queue: queueNotConfigured }, 0);
    expect(report.db.status).toBe("down");
    expect(report.status).toBe("down");
  });
});

describe("health server", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          resolve();
        });
      else resolve();
    });
    server = undefined;
  });

  async function start(db: HealthCheck): Promise<string> {
    server = await startHealthServer({
      port: 0,
      checks: { db, queue: queueNotConfigured },
      logger: createLogger({ level: "silent" }),
    });
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it("serves /health and /healthz as JSON with db and queue status", async () => {
    const base = await start(up);
    for (const path of ["/health", "/healthz"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({
        status: "degraded",
        db: { status: "ok" },
        queue: { status: "not_configured" },
      });
    }
  });

  it("returns 503 when the db is down", async () => {
    const base = await start(down);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "down", db: { status: "down" } });
  });

  it("returns 404 for other paths and methods", async () => {
    const base = await start(up);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(404);
  });
});
