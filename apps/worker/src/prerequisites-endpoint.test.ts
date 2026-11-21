import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { runPrerequisiteChecks } from "./prerequisites/index.js";
import { isLoopbackAddress, startHealthServer } from "./server.js";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function start(prerequisites?: Parameters<typeof startHealthServer>[0]["prerequisites"]) {
  const server = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    logger: createLogger({ level: "silent" }),
    checks: { db: () => Promise.resolve({ ok: true }), queue: () => Promise.resolve({ ok: true }) },
    prerequisites,
  } as unknown as Parameters<typeof startHealthServer>[0]);
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("GET /prerequisites", () => {
  it("returns only name, status and reason for each check, all passing", async () => {
    const base = await start(() => runPrerequisiteChecks());
    const res = await fetch(`${base}/prerequisites`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, unknown>[] };
    expect(body.results).toHaveLength(4);
    for (const r of body.results) {
      expect(Object.keys(r).sort()).toEqual(["name", "status"]);
      expect(r.status).toBe("pass");
    }
  });

  it("reports a failing check by name and reason code only", async () => {
    const base = await start(() =>
      Promise.resolve([
        { name: "sandbox_hardened" as const, status: "fail" as const, reason: "network_not_none" },
      ]),
    );
    const body = (await (await fetch(`${base}/prerequisites`)).json()) as { results: unknown[] };
    expect(body.results).toEqual([
      { name: "sandbox_hardened", status: "fail", reason: "network_not_none" },
    ]);
  });

  it("is a bare 500 with no error text when the report fails", async () => {
    const base = await start(() => Promise.reject(new Error("db password=hunter2 at /srv/app")));
    const res = await fetch(`${base}/prerequisites`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"unavailable"}');
  });

  it("is GET only and has no body or side effects", async () => {
    let calls = 0;
    const base = await start(() => {
      calls += 1;
      return Promise.resolve([]);
    });
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(`${base}/prerequisites`, { method })).status).toBe(404);
    }
    expect(calls).toBe(0);
  });

  it("does not exist when no provider is wired, and /health is unchanged", async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/prerequisites`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).not.toBe(404);
  });

  it("answers loopback callers only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("172.17.0.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
