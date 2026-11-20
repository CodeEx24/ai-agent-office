import { z } from "zod";

import type { AgentTool } from "../agent/tools.js";
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
      const result = await deps.runner.run({
        workspaceId: context.workspaceId,
        runId: context.runId,
        command: parsed.command,
        files: parsed.files,
        limits: deps.limits,
        signal: context.signal,
      });
      if (result.kind === "denied") throw new SandboxDeniedError(result.reason, result.message);
      return `exit_code: ${String(result.exitCode)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    },
  };
}
