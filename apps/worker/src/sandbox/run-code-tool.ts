import { z } from "zod";

import type { AgentTool } from "../agent/tools.js";
import type { EgressRuntimeAllowlist } from "../egress/egress-launcher.js";

/** What the model is told when the sandbox or its egress proxy could not start. Never runtime output. */
export const RUNTIME_UNAVAILABLE_MESSAGE = "the sandbox is unavailable; the code did not run";
import type { SandboxLimits, SandboxRunner } from "./sandbox-runner.js";

/** Thrown for a denied sandbox call. The loop records it as `tool_call.failed` with this message. */
export class SandboxDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(`sandbox_denied (${reason}): ${message}`);
    this.name = "SandboxDeniedError";
    this.reason = reason;
  }
}

const runCodeInputSchema = z.strictObject({
  command: z.array(z.string().min(1).max(16_384)).min(1).max(64),
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(200), content: z.string().max(1_048_576) }))
    .max(32)
    .optional(),
});

/**
 * `run_code`: runs a command in the per-run sandbox. Tier 3, capability `code.run` (starter catalog). It is
 * NOT on the default policy allowlist, so it stays denied until the policy engine grants it; the sandbox
 * only ever runs after that decision. Limits come from the worker, never from the model.
 */
export function createRunCodeTool(deps: {
  readonly runner: SandboxRunner;
  readonly limits?: Partial<SandboxLimits>;
  /**
   * Egress for the run (AGO-65, wired by AGO-85): worker code looks the workspace allowlist up here, so the
   * model never supplies it (`SandboxRequest.egress` is not in either input schema). An allowlist with no
   * hosts leaves the run on `--network none`. A lookup that throws is a deny, never a network.
   */
  readonly egressFor?: (workspaceId: string) => Promise<EgressRuntimeAllowlist>;
}): AgentTool {
  return {
    name: "run_code",
    description:
      "Runs a command in an isolated sandbox: no network, no access to the host, limited CPU, memory and time. " +
      "Optional input files are placed in the working directory. Returns the exit code, stdout and stderr.",
    tier: 3,
    capabilityKey: "code.run",
    inputSchema: runCodeInputSchema,
    modelInputSchema: {
      type: "object",
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          description:
            'The program and its arguments, run without a shell, e.g. ["sh", "-c", "echo hi"].',
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const parsed = runCodeInputSchema.parse(input);
      let egress: EgressRuntimeAllowlist | undefined;
      if (deps.egressFor !== undefined) {
        try {
          const allowlist = await deps.egressFor(context.workspaceId);
          if (allowlist.hosts.length > 0) egress = allowlist;
        } catch {
          throw new SandboxDeniedError("runtime_unavailable", RUNTIME_UNAVAILABLE_MESSAGE);
        }
      }
      const result = await deps.runner.run({
        workspaceId: context.workspaceId,
        runId: context.runId,
        command: parsed.command,
        files: parsed.files,
        limits: deps.limits,
        egress,
        signal: context.signal,
      });
      if (result.kind === "denied") {
        // The runtime's own message can carry docker or proxy output (stderr, paths, addresses): the model gets
        // a fixed sentence instead. The detail stays in the worker logs.
        const message =
          result.reason === "runtime_unavailable" ? RUNTIME_UNAVAILABLE_MESSAGE : result.message;
        throw new SandboxDeniedError(result.reason, message);
      }
      return `exit_code: ${String(result.exitCode)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    },
  };
}
