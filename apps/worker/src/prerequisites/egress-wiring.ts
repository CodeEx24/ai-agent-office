import { createFileEgressAllowlistProvider } from "../egress/allowlist-config.js";
import { createEgressDecisionLogger } from "../egress/egress-launcher.js";
import { createEgressLogLimiter } from "../egress/egress-log-limiter.js";
import { createDockerSandboxRunner } from "../sandbox/docker-runner.js";
import { createRunCodeTool } from "../sandbox/run-code-tool.js";

import type { AgentTool } from "../agent/tools.js";
import type { Logger } from "../logger.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";

/**
 * Production wiring of `run_code` and its egress (AGO-85, from the AGO-65 notes):
 * - the allowlist comes from the host file named by `EGRESS_ALLOWLIST_FILE` (re-read on every run; unset,
 *   unreadable or invalid means deny all, so the run stays on `--network none`);
 * - every proxy decision goes to the structured logger, blocks capped per run, with one summary line when a
 *   run is over the cap;
 * - the model never supplies any of it: `SandboxRequest.egress` is set here and nowhere else.
 */
export function createEgressWiredRunCodeTool(
  logger: Logger,
  env: { readonly EGRESS_ALLOWLIST_FILE?: string } = process.env,
): AgentTool {
  const allowlist = createFileEgressAllowlistProvider({
    path: env.EGRESS_ALLOWLIST_FILE,
    warn: (message) => {
      logger.warn({}, message);
    },
  });
  const limiter = createEgressLogLimiter(createEgressDecisionLogger(logger), (summary) => {
    logger.warn(
      { run_id: summary.runId, suppressed: summary.suppressed },
      "egress blocked requests over the log cap",
    );
  });
  const docker = createDockerSandboxRunner({ onEgressDecision: limiter.onDecision });
  const runner: SandboxRunner = {
    async run(request) {
      try {
        return await docker.run(request);
      } finally {
        limiter.flush(request.runId);
      }
    },
  };
  return createRunCodeTool({
    runner,
    egressFor: (workspaceId) => allowlist.forWorkspace(workspaceId),
  });
}
