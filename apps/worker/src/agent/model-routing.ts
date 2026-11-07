import { isAgentModelId, type AgentModelId } from "@ago/shared";

import { NonRetryableRunError } from "../queue/run-processor.js";

import type { Queryable } from "../context/pg-context-sources.js";
import type { ModelProvider } from "./model-provider.js";

/**
 * Per-agent model routing (AGO-94). The agent's own `agents.model` column picks the model; nothing else can.
 *
 * - The model is read from the agent row when a run starts, never from the job payload (it has no such
 *   field) and never from model output.
 * - It must be on the shared allowlist (`AGENT_MODELS`, the same list the wizard saves against). A value
 *   that is empty, unknown or since removed fails the run with a fixed reason. There is no fallback to a
 *   default model: a fallback could silently pick a pricier one.
 * - One provider serves the whole run. A change to the agent's model while a run is in flight applies to
 *   the next run (or the next retry attempt), not to the steps left in this one, so a run never mixes models.
 */

/** Reasons a run fails when its model cannot be resolved. */
export const MODEL_ROUTING_REASON = {
  agentNotFound: "agent_not_found",
  modelNotAllowed: "model_not_allowed",
} as const;

/** Fixed text: the stored value is never echoed. */
export const MODEL_ROUTING_MESSAGE = {
  agentNotFound: "the agent for this run was not found",
  modelNotAllowed: "the agent's model is not set or is not on the allowlist",
} as const;

export interface AgentRef {
  readonly workspaceId: string;
  readonly agentId: string;
}

/** Reads the raw model setting of one agent. Null when the agent does not exist. */
export interface AgentModelSource {
  loadAgentModel(ref: AgentRef): Promise<string | null>;
}

/** Builds the provider for one allowlisted model. The provider owns its credential. */
export type ProviderFactory = (model: AgentModelId) => ModelProvider;

/** What the loop asks for at the start of a run. */
export interface ModelRouter {
  resolve(ref: AgentRef): Promise<ModelProvider>;
}

export function createModelRouter(deps: {
  readonly source: AgentModelSource;
  readonly createProvider: ProviderFactory;
}): ModelRouter {
  return {
    async resolve(ref: AgentRef): Promise<ModelProvider> {
      const stored = await deps.source.loadAgentModel(ref);
      if (stored === null) {
        throw new NonRetryableRunError(
          MODEL_ROUTING_REASON.agentNotFound,
          MODEL_ROUTING_MESSAGE.agentNotFound,
        );
      }
      if (!isAgentModelId(stored)) {
        throw new NonRetryableRunError(
          MODEL_ROUTING_REASON.modelNotAllowed,
          MODEL_ROUTING_MESSAGE.modelNotAllowed,
        );
      }
      return deps.createProvider(stored);
    },
  };
}

/**
 * Postgres source. The worker's connection bypasses row level security, so the statement names
 * `workspace_id` explicitly and matches the agent on the composite `(workspace_id, id)` key.
 */
export function createPgAgentModelSource(db: Queryable): AgentModelSource {
  return {
    async loadAgentModel(ref: AgentRef): Promise<string | null> {
      const result = await db.query(
        `select model from public.agents where workspace_id = $1 and id = $2`,
        [ref.workspaceId, ref.agentId],
      );
      const row = result.rows[0] as { model?: unknown } | undefined;
      if (row === undefined) return null;
      return typeof row.model === "string" ? row.model : "";
    },
  };
}
