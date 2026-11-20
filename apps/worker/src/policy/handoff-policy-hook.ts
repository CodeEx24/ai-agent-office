import { createPolicyEngineHook } from "./policy-engine-hook.js";

import type { HandoffRecord, HandoffStore } from "../handoff/handoff-store.js";
import type { PolicyContext, PolicyHook, PolicyToolCall } from "../agent/policy-hook.js";
import type { PolicyInputs, PolicySource } from "./pg-policy-source.js";
import type { PolicyEngineGrant } from "@ago/shared";

/**
 * Enforces a handoff's narrowed permissions at run time (AGO-81). For a run that works on a handoff task, the
 * receiver's grants are CLAMPED to the handoff's intersection before the pure policy engine sees them:
 * - a capability not in the handoff disappears, so the engine answers `not_granted`;
 * - the tier is the higher of the grant's and the handoff's, and `approval` mode wins, so nothing gets looser;
 * - tier 3 and 4 still escalate in the engine; a handoff carries no approval and cannot pre-satisfy one.
 * An ordinary run (no handoff) is checked exactly as before. A store error reaches the loop, which denies.
 * `evaluatePolicy` is not changed: this only narrows its input.
 */
export function clampToHandoff(inputs: PolicyInputs, handoff: HandoffRecord): PolicyInputs {
  const grants = inputs.agent.grants.flatMap((grant): PolicyEngineGrant[] => {
    const narrowed = handoff.narrowed.capabilities.find(
      (candidate) => candidate.capabilityKey === grant.capabilityKey,
    );
    if (narrowed === undefined) return [];
    return [
      {
        ...grant,
        tier: Math.max(grant.tier, narrowed.tier) as PolicyEngineGrant["tier"],
        mode: grant.mode === "approval" || narrowed.mode === "approval" ? "approval" : "automatic",
      },
    ];
  });
  return { ...inputs, agent: { ...inputs.agent, grants } };
}

export function createHandoffPolicyHook(deps: {
  readonly source: PolicySource;
  readonly store: Pick<HandoffStore, "findByRun">;
  readonly builtinTools?: readonly string[];
}): PolicyHook {
  return {
    async check(call: PolicyToolCall, context: PolicyContext) {
      const handoff = await deps.store.findByRun(context.workspaceId, context.runId);
      const source: PolicySource =
        handoff === null
          ? deps.source
          : {
              load: async (scope) => clampToHandoff(await deps.source.load(scope), handoff),
            };
      return createPolicyEngineHook({
        source,
        ...(deps.builtinTools === undefined ? {} : { builtinTools: deps.builtinTools }),
      }).check(call, context);
    },
  };
}
