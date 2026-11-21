import type { EgressDecision } from "@ago/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDockerSandboxRunner } from "../sandbox/docker-runner.js";
import {
  SANDBOX_IMAGE,
  type SandboxRequest,
  type SandboxResult,
} from "../sandbox/sandbox-runner.js";
import { createRunScope, docker, dockerReady } from "./docker-test-support.js";
import { EGRESS_PROXY_IMAGE, startEgressProxy } from "./egress-launcher.js";

// Real containers: the proof that the proxy is verified from OUTSIDE the sandbox (AGO-65 AC2). No outbound call
// to any real third-party host: the "internet" is a local target container reached only through the proxy.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ready = dockerReady();
if (!ready.ok) {
  // Printed on purpose: a skipped egress suite must say why (CI may not have Docker).
  console.warn(`[egress] SKIPPING the real-container egress tests: ${ready.reason}`);
}

// Run ids are unique to this process; "leaves nothing behind" is checked only for what this file created.
const scope = createRunScope();
const TARGET_NAME = `ago-egress-target-${String(process.pid)}`;
const TARGET_SCRIPT = [
  'const http = require("http");',
  "for (const port of [80, 8081]) {",
  "  http.createServer((req, res) => {",
  '    console.log("HIT " + port + " " + req.method + " " + req.url);',
  '    res.end("target-ok-" + port);',
  '  }).listen(port, "0.0.0.0");',
  "}",
].join("\n");

let targetIp = "";
const decisions: EgressDecision[] = [];
let counter = 0;

function targetHits(): string[] {
  return docker(["logs", TARGET_NAME])
    .out.split("\n")
    .filter((line) => line.startsWith("HIT "));
}

function makeRunner(): ReturnType<typeof createDockerSandboxRunner> {
  return createDockerSandboxRunner({
    onEgressDecision: (decision) => decisions.push(decision),
    unsafeAllowEgressAddressesForTests: [targetIp],
    egressAddHostsForTests: [
      `allowed.test:${targetIp}`,
      `other.test:${targetIp}`,
      "rebind.test:127.0.0.1",
      "meta.test:169.254.169.254",
    ],
  });
}

async function run(script: string, egress: SandboxRequest["egress"]): Promise<string> {
  counter += 1;
  const runId = scope.id(`egress-${String(counter)}`);
  const result: SandboxResult = await makeRunner().run({
    workspaceId: "ws-egress",
    runId,
    command: ["sh", "-c", script],
    egress,
    limits: { timeoutMs: 60_000 },
  });
  if (result.kind !== "completed") throw new Error(`denied: ${result.reason} ${result.message}`);
  return result.stdout;
}

const ALLOW = { hosts: ["allowed.test"], ports: [80] };

beforeAll(() => {
  if (!ready.ok) return;
  docker(["rm", "-f", TARGET_NAME]);
  const started = docker([
    "run",
    "-d",
    "--name",
    TARGET_NAME,
    "--label",
    "ago.egress.test=true",
    EGRESS_PROXY_IMAGE,
    "node",
    "-e",
    TARGET_SCRIPT,
  ]);
  if (!started.ok) throw new Error(`could not start the target: ${started.out}`);
  targetIp = docker([
    "inspect",
    "-f",
    '{{(index .NetworkSettings.Networks "bridge").IPAddress}}',
    TARGET_NAME,
  ]).out;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(targetIp)) throw new Error(`no target IP: ${targetIp}`);
});

afterAll(() => {
  if (!ready.ok) return;
  docker(["rm", "-f", TARGET_NAME]);
  scope.cleanup();
});

const PROXY_VARS = "P=${HTTP_PROXY#http://}; H=${P%:*}; PT=${P#*:}";

function parseLines(out: string): Record<string, string> {
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]),
  );
}

describe.skipIf(!ready.ok)("egress proxy, verified from inside a real sandbox", () => {
  it("has no route out except the proxy: direct IP, metadata, IPv6, outside DNS and other proxy ports all fail", async () => {
    const out = await run(
      [
        PROXY_VARS,
        't() { n=$1; shift; if "$@" >/dev/null 2>&1; then echo "$n:REACHED"; else echo "$n:blocked"; fi; }',
        "t direct_ip_80 nc -w 3 -z 93.184.216.34 80",
        "t direct_ip_443 nc -w 3 -z 93.184.216.34 443",
        "t metadata nc -w 3 -z 169.254.169.254 80",
        "t ipv6 nc -w 3 -z 2606:4700:4700::1111 80",
        "t dns_outside nslookup example.com 8.8.8.8",
        "t dns_default nslookup example.com",
        `t target_direct nc -w 3 -z ${targetIp} 80`,
        "t proxy_22 nc -w 3 -z $H 22",
        "t proxy_8080 nc -w 3 -z $H 8080",
        "t proxy_9229 nc -w 3 -z $H 9229",
        "t proxy_3128 nc -w 3 -z $H 3128",
      ].join("\n"),
      ALLOW,
    );
    const result = parseLines(out);
    for (const probe of [
      "direct_ip_80",
      "direct_ip_443",
      "metadata",
      "ipv6",
      "dns_outside",
      "dns_default",
      "target_direct",
      "proxy_22",
      "proxy_8080",
      "proxy_9229",
    ]) {
      expect(result[probe], probe).toBe("blocked");
    }
    // sanity: the one thing that must work is the proxy port itself
    expect(result.proxy_3128).toBe("REACHED");
    expect(targetHits()).toHaveLength(0);
  });

  it("lets an allowlisted host through the proxy and blocks (and logs) everything else", async () => {
    decisions.length = 0;
    const out = await run(
      [
        PROXY_VARS,
        'c() { printf "CONNECT $1 HTTP/1.1\\r\\nHost: $1\\r\\n\\r\\n" | nc -w 5 $H $PT | head -1 | tr -d "\\r"; }',
        'echo "allowed_http:$(wget -q -O- -T 8 http://allowed.test/page 2>&1)"',
        'echo "other_http:$(wget -q -O- -T 8 http://other.test/secret?token=abc 2>&1)"',
        'echo "connect_other:$(c other.test:80)"',
        'echo "connect_port:$(c allowed.test:8081)"',
        'echo "connect_proxy:$(c $H:$PT)"',
        'echo "connect_meta:$(c meta.test:80)"',
        'echo "connect_rebind:$(c rebind.test:80)"',
        'echo "connect_ip:$(c 93.184.216.34:80)"',
        'echo "connect_allowed:$(printf "CONNECT allowed.test:80 HTTP/1.1\\r\\nHost: allowed.test:80\\r\\n\\r\\nGET /tunnel HTTP/1.0\\r\\nHost: allowed.test\\r\\n\\r\\n" | nc -w 5 $H $PT | tr -d "\\r" | tr "\\n" "|")"',
      ].join("\n"),
      // meta.test and rebind.test ARE allowlisted here: they must still be blocked because they resolve to
      // the metadata address and to loopback (SSRF / DNS rebinding).
      { hosts: ["allowed.test", "meta.test", "rebind.test"], ports: [80] },
    );
    const lines = parseLines(out);
    expect(lines.allowed_http).toBe("target-ok-80");
    expect(lines.other_http).toMatch(/403/);
    for (const key of [
      "connect_other",
      "connect_port",
      "connect_proxy",
      "connect_meta",
      "connect_rebind",
    ]) {
      expect(lines[key], key).toMatch(/ 403 /);
    }
    expect(lines.connect_ip).toMatch(/ (400|403) /);
    expect(lines.connect_allowed).toMatch(/200 Connection Established/);
    expect(lines.connect_allowed).toContain("target-ok-80");

    // The target saw only the two requests for the allowlisted host: never other.test, port 8081, or the rest.
    expect(targetHits().sort()).toEqual(["HIT 80 GET /page", "HIT 80 GET /tunnel"]);

    const blocked = decisions.filter((d) => d.event === "egress.blocked");
    const reasonFor = (host: string, port: number) =>
      blocked.find((d) => d.host === host && d.port === port)?.reason;
    expect(reasonFor("other.test", 80)).toBe("not_allowlisted");
    expect(reasonFor("allowed.test", 8081)).toBe("port_not_allowed");
    expect(reasonFor("meta.test", 80)).toBe("private_address");
    expect(reasonFor("rebind.test", 80)).toBe("private_address");
    for (const d of blocked) {
      expect(d.run_id).toMatch(/^egress-/);
      expect(d.workspace_id).toBe("ws-egress");
    }
    // never the query string, path or token
    expect(JSON.stringify(decisions)).not.toMatch(/secret|token|abc/);
  });

  it("with an empty allowlist everything is blocked, even a host that is otherwise reachable", async () => {
    const before = targetHits().length;
    const out = await run(
      [PROXY_VARS, 'echo "http:$(wget -q -O- -T 8 http://allowed.test/ 2>&1)"'].join("\n"),
      { hosts: [], ports: [] },
    );
    expect(out).toMatch(/403/);
    expect(targetHits()).toHaveLength(before);
  });

  it("a proxy that is down means deny: no direct connection on the same internal network", async () => {
    const downRunId = scope.id("egress-down");
    const started = await startEgressProxy({
      runId: downRunId,
      workspaceId: "ws-egress",
      allowlist: ALLOW,
    });
    if (!started.ok) throw new Error(started.message);
    const { session } = started;
    try {
      const proxyId = docker(["ps", "-q", "--filter", `label=ago.egress.run=${downRunId}`]).out;
      expect(proxyId).not.toBe("");
      docker(["kill", proxyId]);
      const [host = "", port = ""] = session.proxyUrl.replace("http://", "").split(":");
      const probe = docker([
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        session.networkName,
        SANDBOX_IMAGE,
        "sh",
        "-c",
        `nc -w 3 -z 93.184.216.34 80 && echo REACHED; nc -w 3 -z ${host} ${port} && echo PROXY_UP; echo done`,
      ]);
      expect(probe.out).toContain("done");
      expect(probe.out).not.toContain("REACHED");
      expect(probe.out).not.toContain("PROXY_UP");
    } finally {
      await session.stop();
    }
  });

  it("is a typed deny, with no sandbox started, when the proxy cannot start", async () => {
    const noProxyRunId = scope.id("egress-noproxy");
    const runner = createDockerSandboxRunner({ egressImage: `node@sha256:${"0".repeat(64)}` });
    const result = await runner.run({
      workspaceId: "ws-egress",
      runId: noProxyRunId,
      command: ["sh", "-c", "echo should-not-run"],
      egress: ALLOW,
    });
    expect(result).toMatchObject({ kind: "denied", reason: "runtime_unavailable" });
    expect(
      docker(["ps", "-a", "-q", "--filter", `label=ago.sandbox.run=${noProxyRunId}`]).out,
    ).toBe("");
  });

  it("an invalid allowlist is refused before anything starts", async () => {
    const result = await createDockerSandboxRunner().run({
      workspaceId: "ws-egress",
      runId: scope.id("egress-badlist"),
      command: ["true"],
      egress: { hosts: ["*.com"], ports: [80] },
    });
    expect(result).toMatchObject({ kind: "denied", reason: "invalid_request" });
  });

  it("leaves no proxy container or network behind", () => {
    expect(scope.leftovers()).toBe("");
  });
});
