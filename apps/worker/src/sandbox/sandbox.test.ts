import { describe, expect, it, vi } from "vitest";

import { createDenyByDefaultPolicyHook } from "../agent/policy-hook.js";
import { createToolRegistry } from "../agent/tools.js";
import { buildDockerRunArgs } from "./docker-runner.js";
import { SandboxDeniedError, createRunCodeTool } from "./run-code-tool.js";
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_IMAGE,
  SANDBOX_LIMIT_BOUNDS,
  resolveSandboxLimits,
  validateSandboxRequest,
  type SandboxRequest,
  type SandboxRunner,
} from "./sandbox-runner.js";
import { createTar } from "./tar.js";

const base: SandboxRequest = { workspaceId: "ws-1", runId: "run-1", command: ["echo", "hi"] };

function args(hasFiles = false): string[] {
  return buildDockerRunArgs({
    name: "ago-sbx-test",
    runId: "run-1",
    image: SANDBOX_IMAGE,
    limits: DEFAULT_SANDBOX_LIMITS,
    command: ["echo", "hi"],
    hasFiles,
    uid: 65534,
  });
}

describe("docker run flags", () => {
  const joined = (list: string[]) => list.join(" ");

  it("sets every isolation flag", () => {
    const flags = joined(args());
    for (const expected of [
      "--network none",
      "--ipc none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--user 65534:65534",
      "--memory 256m",
      "--memory-swap 256m",
      "--cpus 1",
      "--pids-limit 64",
      "--ulimit nofile=256:256",
      "--ulimit nproc=64:64",
      "--init",
      "--label ago.sandbox=true",
      "--label ago.sandbox.run=run-1",
    ]) {
      expect(flags).toContain(expected);
    }
  });

  it("never mounts a host path or the Docker socket and never weakens the default profiles", () => {
    const list = args(true);
    for (const forbidden of [
      "-v",
      "--volume",
      "--mount",
      "--privileged",
      "--cap-add",
      "--pid",
      "--userns",
    ]) {
      expect(list).not.toContain(forbidden);
    }
    const flags = joined(list);
    expect(flags).not.toContain("unconfined");
    expect(flags).not.toContain("docker.sock");
    expect(flags).not.toContain("seccomp");
    expect(flags).not.toContain("--network host");
    // The only writable places are size-capped tmpfs mounts.
    expect(list.filter((a) => a === "--tmpfs")).toHaveLength(2);
  });

  it("uses a base image pinned by digest and never pulls at run time", () => {
    expect(SANDBOX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    const list = args();
    expect(list[list.indexOf("--pull") + 1]).toBe("never");
  });

  it("unpacks input files first, then execs the command without a shell string from the model", () => {
    const list = args(true);
    const at = list.indexOf(SANDBOX_IMAGE);
    expect(list.slice(at + 1)).toEqual([
      "sh",
      "-c",
      'tar -x -f - -C /work && exec "$@"',
      "sandbox",
      "echo",
      "hi",
    ]);
  });
});

describe("limits", () => {
  it("clamps every limit into its bounds, so nothing is unlimited", () => {
    const limits = resolveSandboxLimits({
      timeoutMs: 10 ** 9,
      memoryMb: 10 ** 9,
      cpus: 64,
      pids: 10 ** 6,
      scratchMb: -5,
      outputBytes: Number.POSITIVE_INFINITY,
      maxOpenFiles: Number.NaN,
    });
    expect(limits.timeoutMs).toBe(SANDBOX_LIMIT_BOUNDS.timeoutMs.max);
    expect(limits.memoryMb).toBe(SANDBOX_LIMIT_BOUNDS.memoryMb.max);
    expect(limits.cpus).toBe(SANDBOX_LIMIT_BOUNDS.cpus.max);
    expect(limits.pids).toBe(SANDBOX_LIMIT_BOUNDS.pids.max);
    expect(limits.scratchMb).toBe(SANDBOX_LIMIT_BOUNDS.scratchMb.min);
    expect(limits.outputBytes).toBe(DEFAULT_SANDBOX_LIMITS.outputBytes);
    expect(limits.maxOpenFiles).toBe(DEFAULT_SANDBOX_LIMITS.maxOpenFiles);
  });

  it("uses safe defaults when nothing is given", () => {
    expect(resolveSandboxLimits()).toEqual(DEFAULT_SANDBOX_LIMITS);
  });
});

describe("request validation", () => {
  it("accepts a normal request", () => {
    expect(
      validateSandboxRequest({ ...base, files: [{ path: "a/b.txt", content: "x" }] }),
    ).toBeUndefined();
  });

  it.each([
    ["empty command", { command: [] }],
    ["option-looking program", { command: ["--privileged"] }],
    ["NUL in argument", { command: ["echo", "a\0b"] }],
    ["unsafe run id", { runId: "x; rm -rf /" }],
    ["absolute file path", { files: [{ path: "/etc/passwd", content: "" }] }],
    ["parent path", { files: [{ path: "../x", content: "" }] }],
    ["nested parent path", { files: [{ path: "a/../../x", content: "" }] }],
    ["backslash path", { files: [{ path: "a\\b", content: "" }] }],
    [
      "duplicate paths",
      {
        files: [
          { path: "a", content: "" },
          { path: "a", content: "" },
        ],
      },
    ],
    ["too much input", { files: [{ path: "a", content: "x".repeat(1024 * 1024 + 1) }] }],
  ])("rejects %s", (_name, patch) => {
    expect(validateSandboxRequest({ ...base, ...patch })).toBeTypeOf("string");
  });
});

describe("tar", () => {
  it("writes 512-byte blocks ending in two zero blocks", () => {
    const tar = createTar([{ path: "a.txt", content: "hello" }]);
    expect(tar.length).toBe(512 + 512 + 1024);
    expect(tar.subarray(0, 5).toString()).toBe("a.txt");
    expect(tar.subarray(512, 517).toString()).toBe("hello");
    expect(tar.subarray(tar.length - 1024).every((b) => b === 0)).toBe(true);
  });
});

describe("run_code tool", () => {
  const context = {
    workspaceId: "ws-1",
    runId: "run-1",
    agentId: "agent-1",
    signal: new AbortController().signal,
  };

  it("is a tier 3 tool for the code.run capability", () => {
    const tool = createRunCodeTool({ runner: { run: vi.fn() } });
    expect(tool.tier).toBe(3);
    expect(tool.capabilityKey).toBe("code.run");
  });

  it("stays denied by the default policy hook, so the sandbox is never reached", async () => {
    const run = vi.fn();
    const registry = createToolRegistry([createRunCodeTool({ runner: { run } })]);
    const tool = registry.get("run_code");
    const decision = await createDenyByDefaultPolicyHook().check(
      {
        callId: "c1",
        toolName: "run_code",
        input: { command: ["id"] },
        tier: tool?.tier ?? 4,
        capabilityKey: tool?.capabilityKey,
        isRegistered: tool !== undefined,
      },
      { workspaceId: "ws-1", runId: "run-1", agentId: "agent-1", step: 1, signal: context.signal },
    );
    expect(decision.decision).toBe("deny");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns exit code and output, and passes worker-set limits, not model-set ones", async () => {
    const run = vi.fn<SandboxRunner["run"]>().mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      durationMs: 5,
    });
    const tool = createRunCodeTool({ runner: { run }, limits: { timeoutMs: 1234 } });
    const text = await tool.execute({ command: ["echo", "hi"] }, context);
    expect(text).toBe("exit_code: 0\nstdout:\nhi\n\nstderr:\n");
    expect(run.mock.calls[0]?.[0].limits).toEqual({ timeoutMs: 1234 });
  });

  it("throws a typed error for a denied call, so the loop logs tool_call.failed", async () => {
    const run = vi.fn<SandboxRunner["run"]>().mockResolvedValue({
      kind: "denied",
      reason: "timeout",
      message: "too slow",
      durationMs: 1,
    });
    const tool = createRunCodeTool({ runner: { run } });
    await expect(tool.execute({ command: ["sleep", "9"] }, context)).rejects.toBeInstanceOf(
      SandboxDeniedError,
    );
    await expect(tool.execute({ command: ["sleep", "9"] }, context)).rejects.toThrow(
      /sandbox_denied \(timeout\)/,
    );
  });

  it("rejects input that is not the declared shape", () => {
    const tool = createRunCodeTool({ runner: { run: vi.fn() } });
    expect(tool.inputSchema.safeParse({ command: "rm -rf /" }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ command: ["id"], limits: { timeoutMs: 1e9 } }).success,
    ).toBe(false);
  });
});
