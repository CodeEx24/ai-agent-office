import {
  PREREQUISITE_NAMES,
  STARTER_CAPABILITIES,
  evaluatePrerequisites,
  type PrerequisiteResult,
} from "@ago/shared";
import { describe, expect, it } from "vitest";

import { createPolicyEngineHook } from "../policy/policy-engine-hook.js";
import { createRunCodeTool } from "../sandbox/run-code-tool.js";
import { createPrerequisiteGatedPolicyHook } from "./prerequisite-gate.js";
import { DEFAULT_PREREQUISITE_PROBES, findHardeningGap, type PrerequisiteProbe } from "./probes.js";
import { runPrerequisiteChecks } from "./run-prerequisites.js";

import type { PolicyContext, PolicyHook, PolicyToolCall } from "../agent/policy-hook.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";

const context: PolicyContext = {
  workspaceId: "w",
  runId: "r",
  agentId: "a",
  step: 1,
  signal: new AbortController().signal,
};
const call = (capabilityKey: string): PolicyToolCall => ({
  callId: "c1",
  toolName: "run_code",
  input: { command: ["true"] },
  tier: 3,
  capabilityKey,
  isRegistered: true,
});
const allowAll: PolicyHook = {
  check: () => Promise.resolve({ decision: "allow", reasonCode: "inner_allowed" }),
};
const passing = PREREQUISITE_NAMES.map((name) => ({ name, status: "pass" as const }));

describe("the real probes run in CI and pass", () => {
  it("every prerequisite passes against the shipped sandbox, egress, broker and approval code", async () => {
    const results = await runPrerequisiteChecks();
    expect(results.map((r) => r.name).sort()).toEqual([...PREREQUISITE_NAMES].sort());
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
    for (const capability of ["code.run", "web.browse", "message.send_outbound"]) {
      expect(evaluatePrerequisites(capability, results).isSatisfied).toBe(true);
    }
  });

  it("has one probe per named prerequisite", () => {
    expect(DEFAULT_PREREQUISITE_PROBES.map((p) => p.name).sort()).toEqual(
      [...PREREQUISITE_NAMES].sort(),
    );
  });
});

describe("findHardeningGap names the broken guarantee", () => {
  const image = "alpine@sha256:" + "a".repeat(64);
  const good = [
    "run",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    image,
  ];
  it("accepts a hardened argument list", () => {
    expect(findHardeningGap(good, { expectedImage: image })).toBeUndefined();
  });
  it.each([
    ["privileged", [...good, "--privileged"]],
    ["not_read_only", good.filter((a) => a !== "--read-only")],
    ["caps_not_dropped", good.map((a) => (a === "ALL" ? "NET_ADMIN" : a))],
    ["new_privileges_allowed", good.filter((a) => a !== "no-new-privileges")],
    ["unconfined_profile", [...good, "--security-opt", "seccomp=unconfined"]],
    ["host_mount", [...good, "-v", "/:/host"]],
    ["docker_socket", [...good, "--env", "X=/var/run/docker.sock"]],
    ["runs_as_root", good.map((a) => (a === "65534:65534" ? "0:0" : a))],
    ["image_not_pinned", good.map((a) => (a === image ? "alpine:latest" : a))],
  ])("reports %s", (reason, args) => {
    expect(findHardeningGap(args, { expectedImage: image })).toBe(reason);
  });
});

describe("runPrerequisiteChecks fails closed", () => {
  const probe = (run: PrerequisiteProbe["run"]): PrerequisiteProbe => ({
    name: "sandbox_hardened",
    run,
  });
  it("a failing probe is a fail with its code", async () => {
    const [r] = await runPrerequisiteChecks({ probes: [probe(() => "network_not_none")] });
    expect(r).toEqual({ name: "sandbox_hardened", status: "fail", reason: "network_not_none" });
  });
  it("a throwing probe is an error and leaks no message", async () => {
    const [r] = await runPrerequisiteChecks({
      probes: [
        probe(() => {
          throw new Error("secret at /etc/passwd");
        }),
      ],
    });
    expect(r?.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("passwd");
  });
  it("a probe that never answers is a timeout", async () => {
    const [r] = await runPrerequisiteChecks({
      probes: [probe(() => new Promise<undefined>(() => undefined))],
      timeoutMs: 20,
    });
    expect(r?.status).toBe("timeout");
  });
  it("a malformed reason is a fail with a fixed code", async () => {
    const [r] = await runPrerequisiteChecks({ probes: [probe(() => "Bad Text/ with spaces")] });
    expect(r).toMatchObject({ status: "fail", reason: "invalid_probe_result" });
  });
});

describe("the tool-call gate", () => {
  const failing = passing.map((r) =>
    r.name === "sandbox_hardened"
      ? { ...r, status: "fail" as const, reason: "network_not_none" }
      : r,
  );

  it("denies a gated capability when a check fails, even if the inner hook would allow", async () => {
    const hook = createPrerequisiteGatedPolicyHook({
      inner: allowAll,
      runChecks: () => Promise.resolve(failing),
    });
    await expect(hook.check(call("code.run"), context)).resolves.toEqual({
      decision: "deny",
      reasonCode: "prerequisite_failed",
    });
  });

  it("denies an enabled, granted, seeded risky capability through the real policy engine", async () => {
    const seeded = STARTER_CAPABILITIES.filter((c) => c.tier >= 3).map((c) => c.key);
    expect(seeded).toContain("code.run");
    const inner = createPolicyEngineHook({
      source: {
        load: () =>
          Promise.resolve({
            agent: {
              mode: "strict",
              grants: [{ capabilityKey: "code.run", tier: 3, mode: "approval", isEnabled: true }],
            },
            policies: [],
          }),
      },
    });
    const failingHook = createPrerequisiteGatedPolicyHook({
      inner,
      runChecks: () => Promise.resolve(failing),
    });
    expect((await failingHook.check(call("code.run"), context)).decision).toBe("deny");
    const passingHook = createPrerequisiteGatedPolicyHook({
      inner,
      runChecks: () => Promise.resolve(passing),
    });
    // With the checks green the engine still asks a human: the gate never approves anything.
    expect((await passingHook.check(call("code.run"), context)).decision).toBe("needs_approval");
  });

  it.each([
    ["a probe report that throws", () => Promise.reject(new Error("boom"))],
    ["an empty report", () => Promise.resolve([])],
  ])("denies on %s", async (_label, runChecks) => {
    const hook = createPrerequisiteGatedPolicyHook({ inner: allowAll, runChecks });
    expect((await hook.check(call("web.browse"), context)).decision).toBe("deny");
  });

  it("does not touch ungated capabilities or built-ins", async () => {
    const hook = createPrerequisiteGatedPolicyHook({
      inner: allowAll,
      runChecks: () => Promise.resolve(failing),
    });
    expect((await hook.check(call("vault.read"), context)).decision).toBe("allow");
    const builtin: PolicyToolCall = { ...call("x"), capabilityKey: undefined, tier: 0 };
    expect((await hook.check(builtin, context)).decision).toBe("allow");
  });

  it("re-checks after the cache window so a regression is caught", async () => {
    let now = 0;
    let report: readonly PrerequisiteResult[] = passing;
    const hook = createPrerequisiteGatedPolicyHook({
      inner: allowAll,
      runChecks: () => Promise.resolve(report),
      cacheTtlMs: 1000,
      now: () => now,
    });
    expect((await hook.check(call("code.run"), context)).decision).toBe("allow");
    report = failing;
    expect((await hook.check(call("code.run"), context)).decision).toBe("allow");
    now = 2000;
    expect((await hook.check(call("code.run"), context)).decision).toBe("deny");
  });
});

describe("SandboxRequest.egress is unreachable from the model", () => {
  it("the run_code schemas have no egress field and strict input rejects it", async () => {
    let seen: unknown;
    const runner = {
      run: (request: unknown) => {
        seen = request;
        return Promise.resolve({ kind: "completed", exitCode: 0, stdout: "", stderr: "" });
      },
    } as unknown as SandboxRunner;
    const tool = createRunCodeTool({ runner });
    expect(JSON.stringify(tool.modelInputSchema)).not.toContain("egress");
    await expect(
      tool.execute(
        { command: ["true"], egress: { hosts: ["evil.example.com"], ports: [443] } },
        { workspaceId: "w", runId: "r", agentId: "a", signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
    expect(seen).toBeUndefined();
  });
});
