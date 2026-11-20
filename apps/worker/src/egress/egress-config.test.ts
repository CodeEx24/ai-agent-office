import { describe, expect, it } from "vitest";

import { buildDockerRunArgs } from "../sandbox/docker-runner.js";
import { DEFAULT_SANDBOX_LIMITS, validateSandboxRequest } from "../sandbox/sandbox-runner.js";
import { DENY_ALL_EGRESS, createFileEgressAllowlistProvider } from "./allowlist-config.js";
import { EGRESS_PROXY_IMAGE, buildProxyRunArgs, proxyEnvironment } from "./egress-launcher.js";

const file = (value: unknown): string => JSON.stringify(value);

function provider(text: string | Error | undefined, warnings: string[] = []) {
  return createFileEgressAllowlistProvider({
    path: text === undefined ? undefined : "/etc/ago/egress.json",
    warn: (message) => warnings.push(message),
    readText: () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text ?? "")),
  });
}

describe("allowlist file loader (default deny)", () => {
  const good = file({
    version: 1,
    workspaces: {
      "ws-a": { hosts: ["api.example.com", "*.cdn.example.com"], ports: [443] },
      "ws-b": { hosts: ["b.example.com"] },
      "ws-empty": { hosts: [] },
    },
  });

  it("returns the listed hosts and ports for a workspace, defaulting ports to 80 and 443", async () => {
    expect(await provider(good).forWorkspace("ws-a")).toEqual({
      hosts: ["api.example.com", "*.cdn.example.com"],
      ports: [443],
    });
    expect(await provider(good).forWorkspace("ws-b")).toEqual({
      hosts: ["b.example.com"],
      ports: [80, 443],
    });
  });

  it("denies an unlisted workspace, an empty list, and inherited object keys", async () => {
    for (const id of ["ws-unknown", "ws-empty", "__proto__", "constructor", "toString"]) {
      expect(await provider(good).forWorkspace(id)).toEqual(DENY_ALL_EGRESS);
    }
  });

  it("denies everything when egress is not configured", async () => {
    expect(await provider(undefined).forWorkspace("ws-a")).toEqual(DENY_ALL_EGRESS);
  });

  it.each([
    ["a missing file", Object.assign(new Error("ENOENT"), { code: "ENOENT" })],
    ["invalid JSON", "{not json"],
    ["an empty file", ""],
    ["the wrong version", file({ version: 2, workspaces: {} })],
    ["an unknown top-level key", file({ version: 1, workspaces: {}, extra: true })],
    [
      "an unknown workspace key (cannot widen)",
      file({ version: 1, workspaces: { "ws-a": { hosts: ["a.com"], allowPrivate: true } } }),
    ],
    [
      "an unsafe test-only field",
      file({
        version: 1,
        workspaces: { "ws-a": { hosts: ["a.com"], unsafeAllowAddressesForTests: ["10.0.0.1"] } },
      }),
    ],
    ["a URL as a host", file({ version: 1, workspaces: { "ws-a": { hosts: ["https://a.com"] } } })],
    ["a bare wildcard", file({ version: 1, workspaces: { "ws-a": { hosts: ["*"] } } })],
    ["a TLD wildcard", file({ version: 1, workspaces: { "ws-a": { hosts: ["*.com"] } } })],
    ["an IP literal", file({ version: 1, workspaces: { "ws-a": { hosts: ["10.0.0.1"] } } })],
    ["a bad port", file({ version: 1, workspaces: { "ws-a": { hosts: ["a.com"], ports: [0] } } })],
  ])("denies everything for %s and warns without leaking the contents", async (_name, content) => {
    const warnings: string[] = [];
    expect(await provider(content, warnings).forWorkspace("ws-a")).toEqual(DENY_ALL_EGRESS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/a\.com|10\.0\.0\.1/);
  });

  it("one bad entry in another workspace makes the whole file untrusted", async () => {
    const text = file({
      version: 1,
      workspaces: { "ws-a": { hosts: ["a.com"] }, "ws-b": { hosts: ["not a host"] } },
    });
    expect(await provider(text).forWorkspace("ws-a")).toEqual(DENY_ALL_EGRESS);
  });
});

describe("egress proxy container flags", () => {
  const args = buildProxyRunArgs({
    name: "ago-egp-x",
    networkName: "ago-egn-x",
    image: EGRESS_PROXY_IMAGE,
    runId: "run-1",
    workspaceId: "ws-1",
    allowlist: { hosts: ["a.example.com"], ports: [443] },
  });
  const joined = args.join(" ");

  it("is hardened: read-only, no capabilities, non-root, limited, no host mounts or published ports", () => {
    for (const flag of [
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--user 65532:65532",
      "--memory 128m",
      "--pids-limit 64",
    ]) {
      expect(joined).toContain(flag);
    }
    for (const forbidden of [
      "--privileged",
      "-v ",
      "--volume",
      "--mount",
      "docker.sock",
      "-p ",
      "--publish",
      "--network host",
      "unconfined",
      "--cap-add",
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("starts on the internal network only, from the digest-pinned image, with no test-only knobs", () => {
    expect(args[args.indexOf("--network") + 1]).toBe("ago-egn-x");
    expect(EGRESS_PROXY_IMAGE).toMatch(/^node@sha256:[0-9a-f]{64}$/);
    expect(joined).not.toContain("UNSAFE");
    expect(joined).not.toContain("--add-host");
    expect(joined).toContain("EGRESS_HOSTS=a.example.com");
    expect(joined).toContain("EGRESS_PORTS=443");
  });
});

describe("sandbox container with egress", () => {
  const base = {
    name: "ago-sbx-x",
    runId: "run-1",
    image: "alpine",
    limits: DEFAULT_SANDBOX_LIMITS,
    command: ["true"],
    hasFiles: false,
  };

  it("keeps --network none and no proxy variables when there is no egress", () => {
    const args = buildDockerRunArgs(base);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args.join(" ")).not.toMatch(/PROXY/i);
  });

  it("joins only the internal network and points the proxy variables at the proxy", () => {
    const args = buildDockerRunArgs({
      ...base,
      egress: { networkName: "ago-egn-x", proxyUrl: "http://172.20.0.2:3128" },
    });
    const joined = args.join(" ");
    expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(args[args.indexOf("--network") + 1]).toBe("ago-egn-x");
    expect(joined).toContain("HTTP_PROXY=http://172.20.0.2:3128");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).not.toContain("bridge");
    expect(joined).not.toContain("--network host");
    expect(Object.keys(proxyEnvironment("http://x:1"))).toContain("https_proxy");
  });

  it("validates the egress allowlist in the request", () => {
    const request = { workspaceId: "ws", runId: "r1", command: ["true"] };
    expect(
      validateSandboxRequest({ ...request, egress: { hosts: ["a.example.com"], ports: [443] } }),
    ).toBeUndefined();
    expect(
      validateSandboxRequest({ ...request, egress: { hosts: [], ports: [] } }),
    ).toBeUndefined();
    expect(
      validateSandboxRequest({ ...request, egress: { hosts: ["*.com"], ports: [80] } }),
    ).toMatch(/egress/);
    expect(
      validateSandboxRequest({ ...request, egress: { hosts: ["a.com"], ports: [70000] } }),
    ).toMatch(/egress/);
  });
});
