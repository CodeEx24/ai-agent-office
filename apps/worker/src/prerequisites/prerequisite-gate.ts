import { evaluatePrerequisites, isGatedCapability, type PrerequisiteResult } from "@ago/shared";

import type {
  PolicyContext,
  PolicyDecision,
  PolicyHook,
  PolicyToolCall,
} from "../agent/policy-hook.js";

/** How long a probe report is reused. Short, so a regression shows up within seconds. */
export const PREREQUISITE_CACHE_TTL_MS = 10_000;

export const PREREQUISITE_DENY_REASON = "prerequisite_failed";

export interface PrerequisiteGateDeps {
  readonly inner: PolicyHook;
  /** Produces the current probe report. Anything it throws is a deny. */
  readonly runChecks: () => Promise<readonly PrerequisiteResult[]>;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Wraps the policy hook (AGO-85). A tool whose capability is gated (code, browse, outbound message) is denied
 * with `prerequisite_failed` whenever any prerequisite it needs does not pass, even when the catalog says the
 * capability is enabled and the agent holds a grant: the `enabled` flag alone never opens a risky capability.
 * The gate only ever adds a deny. When the checks pass, the inner hook decides exactly as before, so approvals
 * and every other rule still apply. A report that cannot be produced is a deny (fail closed).
 */
export function createPrerequisiteGatedPolicyHook(deps: PrerequisiteGateDeps): PolicyHook {
  const ttl = deps.cacheTtlMs ?? PREREQUISITE_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  let cached: { readonly at: number; readonly results: readonly PrerequisiteResult[] } | undefined;
  let pending: Promise<readonly PrerequisiteResult[]> | undefined;

  function report(): Promise<readonly PrerequisiteResult[]> {
    if (cached !== undefined && now() - cached.at < ttl) return Promise.resolve(cached.results);
    pending ??= deps
      .runChecks()
      .then((results) => {
        cached = { at: now(), results };
        return results;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return {
    async check(call: PolicyToolCall, context: PolicyContext): Promise<PolicyDecision> {
      const key = call.capabilityKey;
      if (key !== undefined && isGatedCapability(key)) {
        let isSatisfied = false;
        try {
          isSatisfied = evaluatePrerequisites(key, await report()).isSatisfied;
        } catch {
          isSatisfied = false;
        }
        if (!isSatisfied) return { decision: "deny", reasonCode: PREREQUISITE_DENY_REASON };
      }
      return deps.inner.check(call, context);
    },
  };
}
