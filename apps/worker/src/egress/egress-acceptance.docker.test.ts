import { spawnSync } from "node:child_process";

import type { EgressDecision } from "@ago/shared";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner } from "../sandbox/docker-runner.js";
import { SANDBOX_IMAGE } from "../sandbox/sandbox-runner.js";
import { EGRESS_LABEL, EGRESS_PROXY_IMAGE, startEgressProxy } from "./egress-launcher.js";

// Functional acceptance checks for AGO-65 against real containers, with NO test-only knobs: the proxy uses its
// real resolver and its real private-address block. No outbound call to any third-party host.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function docker(args: string[], timeout = 60_000): { ok: boolean; out: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

function dockerReady(): { ok: true } | { ok: false; reason: string } {
  const info = docker(["info", "--format", "{{.OSType}}"], 20_000);
  if (!info.ok) return { ok: false, reason: "the docker daemon is not reachable" };
  if (info.out !== "linux") return { ok: false, reason: "docker is not running Linux containers" };
  for (const image of [SANDBOX_IMAGE, EGRESS_PROXY_IMAGE]) {
    if (!docker(["image", "inspect", image], 20_000).ok && !docker(["pull", image], 120_000).ok) {
      return { ok: false, reason: `the pinned image ${image} is not available` };
    }
  }
  return { ok: true };
}

const ready = dockerReady();
if (!ready.ok)
  console.warn(`[egress] SKIPPING the real-container acceptance tests: ${ready.reason}`);

const leftovers = (): string => {
  const containers = docker(["ps", "-a", "-q", "--filter", `label=${EGRESS_LABEL}`]).out;
  const networks = docker(["network", "ls", "-q", "--filter", `label=${EGRESS_LABEL}`]).out;
  return `${containers}${networks}`;
};

describe.skipIf(!ready.ok)("egress proxy acceptance, real containers, real resolver", () => {
  it("blocks an allowlisted name that really resolves to loopback (no test knobs), however it is spelled, and logs it", async () => {
    const decisions: EgressDecision[] = [];
    const runner = createDockerSandboxRunner({ onEgressDecision: (d) => decisions.push(d) });
    const result = await runner.run({
      workspaceId: "ws-acc",
      runId: "acc-localhost",
      command: [
        "sh",
        "-c",
        [
          'echo "plain:$(wget -q -O- -T 8 http://localhost/ 2>&1)"',
          'echo "upper:$(wget -q -O- -T 8 http://LOCALHOST./ 2>&1)"',
          "P=${HTTP_PROXY#http://}; H=${P%:*}; PT=${P#*:}",
          'echo "connect:$(printf "CONNECT localhost:443 HTTP/1.1\\r\\nHost: localhost:443\\r\\n\\r\\n" | nc -w 5 $H $PT | head -1 | tr -d "\\r")"',
        ].join("\n"),
      ],
      egress: { hosts: ["localhost"], ports: [80, 443] },
      limits: { timeoutMs: 60_000 },
    });
    if (result.kind !== "completed") throw new Error(`${result.reason} ${result.message}`);
    expect(result.stdout).toMatch(/plain:.*403/);
    expect(result.stdout).toMatch(/upper:.*403/);
    expect(result.stdout).toMatch(/connect:.* 403 /);
    const blocked = decisions.filter((d) => d.event === "egress.blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    expect(blocked.every((d) => d.reason === "private_address" && d.host === "localhost")).toBe(
      true,
    );
    expect(leftovers()).toBe("");
  });

  it("denies, starts no sandbox and leaves nothing behind when the proxy is not ready in time", async () => {
    const started = await startEgressProxy({
      runId: "acc-notready",
      workspaceId: "ws-acc",
      allowlist: { hosts: ["a.example.com"], ports: [443] },
      readyTimeoutMs: 1,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.message).toMatch(/egress|proxy|ready|timed/i);
    expect(docker(["ps", "-a", "-q", "--filter", "label=ago.egress.run=acc-notready"]).out).toBe(
      "",
    );
    expect(leftovers()).toBe("");
  });

  it("removes the proxy and the network when the run is aborted mid-flight", async () => {
    const controller = new AbortController();
    const runner = createDockerSandboxRunner();
    const pending = runner.run({
      workspaceId: "ws-acc",
      runId: "acc-abort",
      command: ["sh", "-c", "sleep 60"],
      egress: { hosts: ["a.example.com"], ports: [443] },
      limits: { timeoutMs: 100_000 },
      signal: controller.signal,
    });
    // wait until the proxy is up, then pull the plug
    for (
      let i = 0;
      i < 60 && docker(["ps", "-q", "--filter", "label=ago.egress.run=acc-abort"]).out === "";
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(docker(["ps", "-q", "--filter", "label=ago.egress.run=acc-abort"]).out).not.toBe("");
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe("denied");
    expect(leftovers()).toBe("");
    expect(docker(["ps", "-a", "-q", "--filter", "label=ago.sandbox.run=acc-abort"]).out).toBe("");
  });

  it("a run without egress still has no network at all (no proxy, no variables)", async () => {
    const runner = createDockerSandboxRunner();
    const result = await runner.run({
      workspaceId: "ws-acc",
      runId: "acc-none",
      command: [
        "sh",
        "-c",
        "env | grep -ci proxy; nc -w 3 -z 93.184.216.34 80 && echo REACHED || echo blocked",
      ],
      limits: { timeoutMs: 30_000 },
    });
    if (result.kind !== "completed") throw new Error(`${result.reason} ${result.message}`);
    expect(result.stdout).toContain("blocked");
    expect(result.stdout).not.toContain("REACHED");
    expect(result.stdout.trim().split("\n")[0]).toBe("0");
    expect(leftovers()).toBe("");
  });
});
