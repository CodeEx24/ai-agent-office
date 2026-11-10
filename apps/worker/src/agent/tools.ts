import { z } from "zod";

import type { ModelToolDefinition } from "./model-provider.js";
import type { CapabilityTier } from "@ago/shared";

/**
 * Tools the agent can call (AGO-167). A tool is data plus an `execute`; it never decides whether it
 * may run. That is the policy hook's job, and the loop is the only caller of `execute`.
 */
export interface AgentTool {
  /** Messages API tool name: letters, digits, `_` and `-`, at most 64 characters. */
  readonly name: string;
  readonly description: string;
  readonly tier: CapabilityTier;
  /**
   * The catalog capability (AGO-125) an agent needs a grant for to use this tool, e.g. `vault.read`.
   * Left out only by a built-in, side-effect free tier-0 tool; the policy engine (AGO-34) denies any other
   * tool without a key.
   */
  readonly capabilityKey?: string;
  /** Validates the model's input. Failing it means the tool is not run. */
  readonly inputSchema: z.ZodType;
  /** JSON Schema sent to the model; must describe the same shape as `inputSchema`. */
  readonly modelInputSchema: Readonly<Record<string, unknown>>;
  execute(input: unknown, context: ToolContext): Promise<string>;
}

export interface ToolContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly signal: AbortSignal;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The set of tools for one run. Fixed at creation: there is no `register` to call later. */
export interface ToolRegistry {
  list(): readonly ModelToolDefinition[];
  get(name: string): AgentTool | undefined;
  /** Every registered tool. The tool offer (AGO-25) picks which of them the model is shown. */
  all(): readonly AgentTool[];
}

export function createToolRegistry(tools: readonly AgentTool[]): ToolRegistry {
  const byName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error("invalid tool name");
    if (byName.has(tool.name)) throw new Error("duplicate tool name");
    byName.set(tool.name, tool);
  }
  const definitions: readonly ModelToolDefinition[] = [...byName.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.modelInputSchema,
  }));
  return {
    list: () => definitions,
    get: (name) => byName.get(name),
    all: () => [...byName.values()],
  };
}

/** Tier 0, no I/O: the one built-in tool. Vault and other tools arrive with their own tickets. */
export const getCurrentTimeTool: AgentTool = {
  name: "get_current_time",
  description: "Returns the current UTC date and time as an ISO 8601 string.",
  tier: 0,
  inputSchema: z.strictObject({}),
  modelInputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: () => Promise.resolve(new Date().toISOString()),
};
