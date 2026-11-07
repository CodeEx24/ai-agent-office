import { createContextBuilder, createPgRunContextSource } from "../context/index.js";
import { createAgentLoop } from "./agent-loop.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createPgPolicySource, createPolicyEngineHook } from "../policy/index.js";
import { createPgAgentRunLimitsSource } from "./pg-run-limits-source.js";
import { createRunLimitsResolver } from "./run-limits.js";
import { createToolRegistry, getCurrentTimeTool } from "./tools.js";

import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { RunExecutor } from "../queue/index.js";
import type pg from "pg";

/**
 * Production wiring for the agent runtime (AGO-167). The model key is read here, from the validated
 * server env (AGO-70), and handed to the provider and nowhere else.
 *
 * Returns undefined when no key is configured: the queue then accepts jobs and nothing consumes them,
 * exactly as before this ticket.
 */
export function createProductionAgentExecutor(options: {
  readonly config: WorkerConfig;
  readonly pool: pg.Pool;
  readonly logger: Logger;
}): RunExecutor | undefined {
  const { config, pool, logger } = options;
  const apiKey = config.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    logger.warn("ANTHROPIC_API_KEY is not set: agent runs will not be consumed");
    return undefined;
  }
  return createAgentLoop({
    provider: createClaudeProvider({ apiKey, model: config.agentModel }),
    contextBuilder: createContextBuilder({
      source: createPgRunContextSource(pool),
      logger,
      maxChars: config.contextMaxChars,
    }),
    // The deterministic policy engine (AGO-34): grants and layered policies are read from the database.
    policy: createPolicyEngineHook({ source: createPgPolicySource(pool) }),
    tools: createToolRegistry([getCurrentTimeTool]),
    limits: {
      maxSteps: config.agentMaxSteps,
      maxTokens: config.agentMaxTokens,
      maxWallMs: config.agentMaxWallMs,
    },
    // Per-agent limits (AGO-166): agents.run_limits overrides the defaults above, always clamped to the caps.
    limitsResolver: createRunLimitsResolver({
      defaults: {
        maxSteps: config.agentMaxSteps,
        maxTokens: config.agentMaxTokens,
        maxWallMs: config.agentMaxWallMs,
      },
      source: createPgAgentRunLimitsSource(pool),
      onSourceError: (error) => {
        logger.error({ err: error }, "could not read an agent's run limits; using defaults");
      },
    }),
    contextMaxChars: config.contextMaxChars,
  });
}
