/**
 * AGO-203: scripts/free-port.mjs must never return a port that another process holds on
 * 127.0.0.1, 0.0.0.0 or ::1. Each case starts a real listener and runs the CLI starting at that port.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url))), "free-port.mjs");
const open = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(() => r()))));
});

/** Listens on an OS-chosen port of `host`; resolves the port, or null when the host is unavailable. */
function hold(host, port = 0) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once("error", () => resolvePort(null));
    server.listen(port, host, () => {
      open.push(server);
      resolvePort(server.address().port);
    });
  });
}

function run(...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args.map(String)], { encoding: "utf8" });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

describe("free-port.mjs", () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "::1"]) {
    test(`never returns a port held on ${host}`, async (ctx) => {
      const held = await hold(host);
      if (held === null) return ctx.skip(); // no IPv6 loopback on this machine
      const { code, out } = run(held);
      expect(code).toBe(0);
      expect(out).toMatch(/^\d+$/);
      expect(Number(out)).toBeGreaterThan(held);
    });
  }

  test("prints a single port number and honours the start argument", () => {
    const { code, out } = run(41000);
    expect(code).toBe(0);
    expect(out).toMatch(/^\d+$/);
    expect(Number(out)).toBeGreaterThanOrEqual(41000);
  });

  test("defaults to a port at or above 3100", () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(Number(out)).toBeGreaterThanOrEqual(3100);
  });
});
