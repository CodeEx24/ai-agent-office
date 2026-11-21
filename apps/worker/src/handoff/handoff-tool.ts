import { z } from "zod";

import { createHandoff } from "./create-handoff.js";

import type { HandoffStore } from "./handoff-store.js";
import type { AgentTool, ToolContext } from "../agent/tools.js";
import type { RunEventEmitter } from "../events/run-event-emitter.js";

/**
 * The `handoff_task` tool (AGO-81): the only way an agent gives work to another agent. It creates a task, it does
 * not send a message. Like every tool it passes the policy engine first (capability `tasks.manage`, tier 1), and
 * `createHandoff` then applies the handoff rule. The result text holds ids and fixed reason codes only.
 *
 * `inputSchema` is permissive on purpose: `createHandoff` receives the raw input, so the strict request schema
 * refuses a forged field and a claimed requester is compared against the stored chain in one place.
 */
export const HANDOFF_TOOL_NAME = "handoff_task";

export function createHandoffTool(deps: {
  readonly store: HandoffStore;
  readonly emitterFor: (context: ToolContext) => RunEventEmitter;
}): AgentTool {
  return {
    name: HANDOFF_TOOL_NAME,
    description:
      "Give a task to another agent in this workspace. The other agent gets only the permissions you both hold. " +
      "This creates a task; it is not a message.",
    tier: 1,
    capabilityKey: "tasks.manage",
    inputSchema: z.unknown(),
    modelInputSchema: {
      type: "object",
      properties: {
        to_agent_id: { type: "string", description: "The receiving agent's id." },
        title: { type: "string", maxLength: 300 },
        description: { type: "string", maxLength: 10000 },
        requested: {
          type: "object",
          properties: {
            capabilities: { type: "array", items: { type: "string" } },
            budget_cents: { type: "integer", minimum: 1 },
            data_scope: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      required: ["to_agent_id", "title"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const result = await createHandoff(
        { store: deps.store, emitter: deps.emitterFor(context) },
        { workspaceId: context.workspaceId, runId: context.runId, agentId: context.agentId },
        input,
      );
      return result.ok
        ? `handoff created: task ${result.taskId}`
        : `handoff refused: ${result.reason}`;
    },
  };
}
