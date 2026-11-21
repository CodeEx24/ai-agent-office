import { createHandoffPolicyHook } from "../policy/handoff-policy-hook.js";

import { createHandoffTool } from "./handoff-tool.js";

import type { HandoffStore } from "./handoff-store.js";
import type { PolicyHook } from "../agent/policy-hook.js";
import type { AgentTool, ToolContext } from "../agent/tools.js";
import type { RunEventEmitter } from "../events/run-event-emitter.js";
import type { PolicySource } from "../policy/pg-policy-source.js";

/**
 * The production wiring for handoffs (AGO-81), kept out of `wire.ts` so that file only gets a small block:
 * the policy hook that clamps a handoff run to its intersection, and the `handoff_task` tool.
 */
export interface HandoffWiring {
  readonly policy: PolicyHook;
  readonly tool: AgentTool;
}

export function createHandoffWiring(deps: {
  readonly source: PolicySource;
  readonly store: HandoffStore;
  readonly emitterFor: (context: ToolContext) => RunEventEmitter;
}): HandoffWiring {
  return {
    policy: createHandoffPolicyHook({ source: deps.source, store: deps.store }),
    tool: createHandoffTool({ store: deps.store, emitterFor: deps.emitterFor }),
  };
}

/**
 * Fail-closed store used until the Postgres store lands (schema slot). No handoff can exist, so every run is an
 * ordinary run (`findByRun` is null) and `handoff_task` is refused: an unknown sender or chain is a denial.
 */
export function createUnavailableHandoffStore(): HandoffStore {
  const unavailable = (): Promise<never> => Promise.reject(new Error("handoff store unavailable"));
  return {
    loadParty: () => Promise.resolve(null),
    loadChainForRun: () => Promise.resolve(null),
    insert: unavailable,
    findByRun: () => Promise.resolve(null),
    findByTask: () => Promise.resolve(null),
    markAccepted: unavailable,
    spentCentsOnTask: unavailable,
    allocatedCentsOnRun: unavailable,
  };
}
