import type { EgressDecision } from "@ago/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner } from "../sandbox/docker-runner.js";
import { createRunScope, docker, dockerReady } from "./docker-test-support.js";
import { startEgressProxy } from "./egress-launcher.js";

// Functional acceptance checks for AGO-65 against real containers, with NO test-only knobs: the proxy uses its
// real resolver and its real private-address block. No outbound call to any third-party host.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ready = dockerReady();
if (!ready.ok)
  console.warn(`[egress] SKIPPING the real-container acceptance tests: ${ready.reason}`);

// Run ids are unique to this process; "leaves nothing behind" is checked only for what this file created.
const scope = createRunScope();
const leftovers = (): string => scope.leftovers();
const RUN = {
  localhost: scope.id("acc-localhost"),
  notReady: scope.id("acc-notready"),
  abort: scope.id("acc-abort"),
  none: scope.id("acc-none"),
};

afterAll(() => {
  if (ready.ok) scope.cleanup();
});

describe.skipIf(!ready.ok)("egress proxy acceptance, real containers, real resolver", () => {
  it("blocks an allowlisted name that really resolves to loopback (no test knobs), however it is spelled, and logs it", async () => {
    const decisions: EgressDecision[] = [];
    const runner = createDockerSandboxRunner({ onEgressDecision: (d) => decisions.push(d) });
    const result = await runner.run({
      workspaceId: "ws-acc",
      runId: RUN.localhost,
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
      runId: RUN.notReady,
      workspaceId: "ws-acc",
      allowlist: { hosts: ["a.example.com"], ports: [443] },
      readyTimeoutMs: 1,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.message).toMatch(/egress|proxy|ready|timed/i);
    expect(docker(["ps", "-a", "-q", "--filter", `label=ago.egress.run=${RUN.notReady}`]).out).toBe(
      "",
    );
    expect(leftovers()).toBe("");
  });

  it("removes the proxy and the network when the run is aborted mid-flight", async () => {
    const controller = new AbortController();
    const runner = createDockerSandboxRunner();
    const pending = runner.run({
      workspaceId: "ws-acc",
      runId: RUN.abort,
      command: ["sh", "-c", "sleep 60"],
      egress: { hosts: ["a.example.com"], ports: [443] },
      limits: { timeoutMs: 100_000 },
      signal: controller.signal,
    });
    // wait until the proxy is up, then pull the plug
    for (
      let i = 0;
      i < 60 && docker(["ps", "-q", "--filter", `label=ago.egress.run=${RUN.abort}`]).out === "";
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(docker(["ps", "-q", "--filter", `label=ago.egress.run=${RUN.abort}`]).out).not.toBe("");
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe("denied");
    expect(leftovers()).toBe("");
    expect(docker(["ps", "-a", "-q", "--filter", `label=ago.sandbox.run=${RUN.abort}`]).out).toBe(
      "",
    );
  });

  it("a run without egress still has no network at all (no proxy, no variables)", async () => {
    const runner = createDockerSandboxRunner();
    const result = await runner.run({
      workspaceId: "ws-acc",
      runId: RUN.none,
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
