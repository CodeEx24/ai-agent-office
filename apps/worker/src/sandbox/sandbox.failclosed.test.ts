import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner, listSandboxContainers } from "./docker-runner.js";
import { createTar } from "./tar.js";
import { SANDBOX_IMAGE, type SandboxFile, type SandboxRequest } from "./sandbox-runner.js";

// AGO-71 round 2 (functional tester): fail-closed and long/multibyte-name gaps found after the round-1 fixes.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const dockerUp =
  spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    timeout: 20_000,
  }).stdout.trim() === "linux" &&
  spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], { timeout: 20_000 }).status === 0;
if (!dockerUp) console.warn("[sandbox-failclosed] SKIPPING real-container tests: docker not ready");

const runner = createDockerSandboxRunner();
const runIds: string[] = [];
let counter = 0;

function request(command: string[], files?: SandboxFile[]): SandboxRequest {
  counter += 1;
  const runId = `fc-${String(process.pid)}-${String(counter)}`;
  runIds.push(runId);
  return { workspaceId: "ws-failclosed", runId, command, ...(files ? { files } : {}) };
}

afterAll(async () => {
  if (!dockerUp) return;
  for (const id of runIds) expect(await listSandboxContainers("docker", id)).toEqual([]);
});

describe("tar packing of long and multibyte names (pure)", () => {
  it("never throws for any path the validator allows (200 four-byte characters)", () => {
    expect(() => createTar([{ path: "😀".repeat(50), content: "x" }])).not.toThrow();
    expect(() => createTar([{ path: "n".repeat(200), content: "x" }])).not.toThrow();
  });

  it("emits a GNU long-name entry only when the name exceeds 100 bytes", () => {
    const at100 = createTar([{ path: "a".repeat(100), content: "x" }]);
    const at101 = createTar([{ path: "a".repeat(101), content: "x" }]);
    // 1 header + 1 data block + 2 end blocks, versus an extra header + name block.
    expect(at100.length).toBe(512 * 4);
    expect(at101.length).toBe(512 * 6);
    expect(at101.subarray(0, 13).toString("latin1")).toBe("././@LongLink");
  });

  it("measures the 100 limit in bytes: 34 three-byte characters (102 bytes) need a long-name entry", () => {
    const archive = createTar([{ path: "€".repeat(34), content: "x" }]);
    expect(archive.length).toBe(512 * 6);
  });
});

describe.skipIf(!dockerUp)("long and multibyte names reach /work intact (real container)", () => {
  const cases: [string, string][] = [
    ["exactly 100 bytes", "a".repeat(100)],
    ["101 bytes", "a".repeat(101)],
    ["200 ascii chars", "b".repeat(200)],
    ["50 four-byte emoji (200 bytes)", "😀".repeat(50)],
    ["80 three-byte characters (240 bytes, under the 255-byte file name limit)", "€".repeat(80)],
  ];

  for (const [label, path] of cases) {
    it(`places a file named with ${label} and keeps its content`, async () => {
      const result = await runner.run(
        request(["sh", "-c", "cat -- *; ls | head -c 400"], [{ path, content: "body" }]),
      );
      expect(result).toMatchObject({ kind: "completed", exitCode: 0 });
      const out = result.kind === "completed" ? result.stdout : "";
      expect(out.startsWith("body")).toBe(true);
      expect(out.slice(4).trim()).toBe(path);
    });
  }

  it("does not run the command when a valid-length name exceeds the 255-byte file name limit (nit: completed exit 1, not invalid_request)", async () => {
    const result = await runner.run(
      request(["sh", "-c", "echo RAN"], [{ path: "€".repeat(120), content: "b" }]),
    );
    expect(result.kind === "completed" ? result.stdout : "").not.toContain("RAN");
    expect(result.kind === "completed" ? result.exitCode : 1).not.toBe(0);
  });

  it("lists every long-named file from one archive without corrupting the next entry", async () => {
    const files: SandboxFile[] = [
      { path: "x".repeat(150), content: "one" },
      { path: "short.txt", content: "two" },
      { path: "y".repeat(180), content: "three" },
    ];
    const result = await runner.run(
      request(
        ["sh", "-c", 'for f in *; do printf \'%s=%s\\n\' "${#f}" "$(cat "$f")"; done'],
        files,
      ),
    );
    expect(result.kind).toBe("completed");
    const lines = result.kind === "completed" ? result.stdout.trim().split("\n").sort() : [];
    expect(lines).toEqual(["150=one", "180=three", "9=two"].sort());
  });

  it("keeps the nested long path directory structure", async () => {
    const path = `${"d".repeat(40)}/${"f".repeat(120)}`;
    const result = await runner.run(
      request(["sh", "-c", `cat "${path}"`], [{ path, content: "nested" }]),
    );
    expect(result).toMatchObject({ kind: "completed", exitCode: 0, stdout: "nested" });
  });
});

describe.skipIf(!dockerUp)("program exit codes that look like Docker errors", () => {
  it("reports exit 126 (not executable) as completed with the shell's message", async () => {
    const result = await runner.run(
      request(["sh", "-c", "printf '#!/bin/sh\\necho hi' > x.sh && ./x.sh"]),
    );
    expect(result).toMatchObject({ kind: "completed", exitCode: 126 });
  });

  it("reports exit 127 (command not found) as completed", async () => {
    const result = await runner.run(request(["definitely-not-a-command"]));
    expect(result).toMatchObject({ kind: "completed" });
    expect(result.kind === "completed" ? result.exitCode : 0).toBeGreaterThanOrEqual(126);
  });

  it("reports a self-inflicted SIGKILL (exit 137 via kill -9) as completed, not out_of_memory", async () => {
    const result = await runner.run(request(["sh", "-c", "kill -9 $$"]));
    expect(result).toMatchObject({ kind: "completed", exitCode: 137 });
  });

  it("still reports a real out-of-memory kill as denied out_of_memory", async () => {
    const result = await runner.run({
      ...request(["sh", "-c", "x=$(head -c 100000000 /dev/zero | tr '\\0' a); echo survived"]),
      limits: { memoryMb: 32, timeoutMs: 60_000 },
    });
    expect(result).toMatchObject({ kind: "denied", reason: "out_of_memory" });
  });
});

describe("daemon failures deny and never run the command (real CLI, bad endpoint)", () => {
  it("denies with runtime_unavailable for a TLS-required host that cannot be reached", async () => {
    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "tcp://127.0.0.1:2";
    try {
      const result = await createDockerSandboxRunner().run(
        request(["sh", "-c", "echo should-not-run"], [{ path: "a.txt", content: "x" }]),
      );
      expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
  }, 120_000);

  it("denies with runtime_unavailable when the Docker context points at a missing unix socket", async () => {
    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent/ago-no-such.sock";
    try {
      const result = await createDockerSandboxRunner().run(request(["echo", "hi"]));
      expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
  }, 120_000);
});
