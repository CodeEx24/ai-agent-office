import type { CapabilityTier } from "@ago/shared";

/**
 * The policy hook (AGO-167). The deterministic policy engine is AGO-34 and lands later; this is the
 * seam it plugs into. The loop calls `check` before EVERY tool execution and has no other way to run
 * a tool (see `executeToolCall` in agent-loop.ts).
 */

export interface PolicyToolCall {
  readonly callId: string;
  readonly toolName: string;
  /** Raw model output. Untrusted. */
  readonly input: unknown;
  /** The registered tool's tier. An unknown tool is reported as tier 4. */
  readonly tier: CapabilityTier;
  /** The registered tool's catalog capability, when it has one. Undefined for unknown tools and built-ins. */
  readonly capabilityKey?: string;
  /** False when the model named a tool that is not registered. */
  readonly isRegistered: boolean;
}

export interface PolicyContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly step: number;
  /**
   * Aborted when the hook's time budget runs out or the run stops. A hook that is still working then
   * must stop; the loop has already treated the call as denied (timeout means deny).
   */
  readonly signal: AbortSignal;
}

export interface PolicyDecision {
  readonly decision: "allow" | "deny" | "needs_approval";
  readonly reasonCode: string;
  readonly ruleId?: string;
}

export interface PolicyHook {
  check(call: PolicyToolCall, context: PolicyContext): Promise<PolicyDecision>;
}

/**
 * Tier 0 tools that are safe to run with no engine: read-only, no I/O, no side effects. Everything
 * else is denied until AGO-34 supplies real rules. Add a name here only for a tool that reads
 * nothing outside the process.
 */
export const DEFAULT_TIER0_ALLOWLIST: readonly string[] = ["get_current_time"];

/**
 * Default hook until AGO-34: deny by default. A call is allowed only when the tool is registered,
 * is tier 0 and is on the explicit allowlist.
 */
export function createDenyByDefaultPolicyHook(
  allowlist: readonly string[] = DEFAULT_TIER0_ALLOWLIST,
): PolicyHook {
  const allowed = new Set(allowlist);
  return {
    check(call) {
      if (!call.isRegistered) {
        return Promise.resolve({ decision: "deny", reasonCode: "unknown_tool" });
      }
      if (call.tier === 0 && allowed.has(call.toolName)) {
        return Promise.resolve({ decision: "allow", reasonCode: "tier0_allowlist" });
      }
      return Promise.resolve({ decision: "deny", reasonCode: "default_deny" });
    },
  };
}
