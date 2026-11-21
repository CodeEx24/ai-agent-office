import { MAX_HANDOFF_DEPTH } from "./handoff-schemas.js";

import type {
  HandoffChain,
  HandoffDenialReason,
  HandoffGrant,
  HandoffParty,
  HandoffRequest,
  NarrowedGrant,
  NarrowedPermissions,
} from "./handoff-schemas.js";

/**
 * Pure handoff rules (AGO-81). No clock, no database, no model. The receiver's permissions are the
 * INTERSECTION of what the sender holds and what the receiver holds, never a union:
 * - capabilities: only keys both agents hold, enabled on both sides;
 * - tier: the higher (stricter) of the two, so a handoff can never lower a tier; tier 3 and 4 still escalate in
 *   the policy engine and a handoff carries no approval;
 * - mode: `approval` when either side is `approval`;
 * - budget: the smallest of the sender's remaining budget, the receiver's budget and the request;
 * - data scope: the overlap of the two path-prefix lists (the longer prefix of each overlapping pair).
 */

export type NarrowResult =
  | { readonly ok: true; readonly permissions: NarrowedPermissions }
  | { readonly ok: false; readonly reason: HandoffDenialReason };

function heldGrant(grants: readonly HandoffGrant[], key: string): HandoffGrant | undefined {
  return grants.find((grant) => grant.isEnabled && grant.capabilityKey === key);
}

/** Overlap of two prefix lists: for each overlapping pair, the longer (narrower) prefix. */
export function intersectDataScopes(a: readonly string[], b: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (x.startsWith(y)) out.add(x);
      else if (y.startsWith(x)) out.add(y);
    }
  }
  return [...out].sort();
}

/** True when every prefix in `wanted` lies inside some prefix of `held`. */
function isScopeCovered(wanted: readonly string[], held: readonly string[]): boolean {
  return wanted.every((prefix) => held.some((h) => prefix.startsWith(h)));
}

export function narrowHandoff(
  sender: HandoffParty,
  receiver: HandoffParty,
  requested: HandoffRequest["requested"],
): NarrowResult {
  if (sender.workspaceId !== receiver.workspaceId) {
    return { ok: false, reason: "workspace_mismatch" };
  }

  const wantedKeys = requested?.capabilities;
  if (wantedKeys?.some((key) => heldGrant(sender.grants, key) === undefined) === true) {
    return { ok: false, reason: "widening_capability" };
  }
  if (requested?.budget_cents !== undefined && requested.budget_cents > sender.budgetCents) {
    return { ok: false, reason: "widening_budget" };
  }
  if (
    requested?.data_scope !== undefined &&
    !isScopeCovered(requested.data_scope, sender.dataScope)
  ) {
    return { ok: false, reason: "widening_scope" };
  }

  const keys = new Set(wantedKeys ?? sender.grants.map((grant) => grant.capabilityKey));
  const capabilities: NarrowedGrant[] = [];
  for (const key of [...keys].sort()) {
    const fromSender = heldGrant(sender.grants, key);
    const fromReceiver = heldGrant(receiver.grants, key);
    if (fromSender === undefined || fromReceiver === undefined) continue;
    capabilities.push({
      capabilityKey: key,
      tier: Math.max(fromSender.tier, fromReceiver.tier) as NarrowedGrant["tier"],
      mode:
        fromSender.mode === "approval" || fromReceiver.mode === "approval"
          ? "approval"
          : "automatic",
    });
  }

  const budgetCents = Math.min(
    sender.budgetCents,
    receiver.budgetCents,
    requested?.budget_cents ?? Number.POSITIVE_INFINITY,
  );
  if (!(budgetCents > 0)) return { ok: false, reason: "no_budget" };

  const wantedScope = requested?.data_scope ?? sender.dataScope;
  const dataScope = intersectDataScopes(
    intersectDataScopes(sender.dataScope, receiver.dataScope),
    wantedScope,
  );
  return { ok: true, permissions: { capabilities, budgetCents, dataScope: [...dataScope] } };
}

export type ChainResult =
  | { readonly ok: true; readonly chain: HandoffChain; readonly depth: number }
  | { readonly ok: false; readonly reason: HandoffDenialReason };

/**
 * The chain after handing off to `receiverAgentId`. Refuses a self-handoff, a cycle (the receiver already is in the
 * path) and a chain deeper than `MAX_HANDOFF_DEPTH`. `chain.path` ends with the sender; an empty path is refused.
 */
export function extendChain(chain: HandoffChain, receiverAgentId: string): ChainResult {
  const sender = chain.path[chain.path.length - 1];
  if (sender === undefined) return { ok: false, reason: "invalid_request" };
  if (sender === receiverAgentId) return { ok: false, reason: "self_handoff" };
  if (chain.path.includes(receiverAgentId)) return { ok: false, reason: "cycle" };
  const depth = chain.path.length;
  if (depth > MAX_HANDOFF_DEPTH) return { ok: false, reason: "depth_exceeded" };
  return { ok: true, depth, chain: { ...chain, path: [...chain.path, receiverAgentId] } };
}
