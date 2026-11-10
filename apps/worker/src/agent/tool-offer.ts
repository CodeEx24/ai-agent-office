import { DEFAULT_TIER0_ALLOWLIST } from "./policy-hook.js";

import type { AgentTool } from "./tools.js";
import type { CredentialStore } from "../identity/credential-store.js";

/**
 * Which tools the model is shown (AGO-25). The model can only ask for a tool it was listed, so an ungranted
 * tool is never offered, and a request for one is denied by the loop (`tool_not_offered`) before anything runs.
 *
 * A tool is offered when:
 * - it names a catalog capability (AGO-125) and the agent holds a grant for it (AGO-141) while the catalog
 *   still has it enabled. This is the same set an agent credential can carry (AGO-148), read fresh from the
 *   database, so a revoked grant or a disabled capability drops out; or
 * - it is a built-in: no capability key, tier 0, on the built-in allowlist (the policy engine's rule).
 * Everything else is withheld, including a tool with no capability key that is not a built-in.
 *
 * This is a filter, not the decision to run: the loop still asks the policy engine (AGO-34) for every offered
 * call, and a tier 3 or 4 tool that is offered still stops for a human.
 */
export interface ToolOfferScope {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runId: string;
}

export interface ToolOffer {
  /** Names of the `tools` to show the model right now. Called before every model call. */
  offeredToolNames(
    tools: readonly AgentTool[],
    scope: ToolOfferScope,
  ): Promise<ReadonlySet<string>>;
}

/** The agent's capability keys that are granted and catalog-enabled right now, within one workspace. */
export interface GrantedCapabilitySource {
  grantedCapabilities(scope: ToolOfferScope): Promise<readonly string[]>;
}

/** Postgres source: reuses the credential store's query (grants joined to enabled catalog entries). */
export function createPgGrantedCapabilitySource(
  store: Pick<CredentialStore, "grantedCapabilities">,
): GrantedCapabilitySource {
  return {
    grantedCapabilities: ({ workspaceId, agentId }) =>
      store.grantedCapabilities({ workspaceId, agentId }),
  };
}

export function createToolOffer(deps: {
  readonly source: GrantedCapabilitySource;
  /** Tier-0 tool names that need no grant. Defaults to the policy engine's built-ins. */
  readonly builtinTools?: readonly string[];
}): ToolOffer {
  const builtins = new Set(deps.builtinTools ?? DEFAULT_TIER0_ALLOWLIST);
  return {
    async offeredToolNames(tools, scope) {
      // A failed read throws: the attempt fails (and is retried) rather than showing a list nobody checked.
      const granted = new Set(await deps.source.grantedCapabilities(scope));
      const offered = new Set<string>();
      for (const tool of tools) {
        const isBuiltin =
          tool.capabilityKey === undefined && tool.tier === 0 && builtins.has(tool.name);
        const isGranted = tool.capabilityKey !== undefined && granted.has(tool.capabilityKey);
        if (isBuiltin || isGranted) offered.add(tool.name);
      }
      return offered;
    },
  };
}
