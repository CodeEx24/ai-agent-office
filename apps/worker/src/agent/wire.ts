import { createContextBuilder, createPgRunContextSource } from "../context/index.js";
import { createAgentLoop } from "./agent-loop.js";
import { createClaudeProvider } from "./claude-provider.js";
import { createModelRouter, createPgAgentModelSource } from "./model-routing.js";
import { createPgPolicySource, createPolicyEngineHook } from "../policy/index.js";
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
    // AGO-94: each run reads its agent's model and gets a provider for exactly that model.
    modelRouter: createModelRouter({
      source: createPgAgentModelSource(pool),
      createProvider: (model) => createClaudeProvider({ apiKey, model }),
    }),
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
    contextMaxChars: config.contextMaxChars,
  });
}
