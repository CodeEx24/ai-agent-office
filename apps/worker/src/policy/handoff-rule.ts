import { extendChain, handoffRequestSchema, narrowHandoff } from "@ago/shared/handoff";

import type {
  HandoffChain,
  HandoffDenialReason,
  HandoffParty,
  HandoffRequest,
  NarrowedPermissions,
} from "@ago/shared/handoff";

/**
 * The deterministic handoff rule (AGO-81). A pure function: the same input always gives the same answer; it reads
 * nothing and never throws. The worker loads the parties and the chain from storage and calls it before a handoff
 * task is created. It is the handoff counterpart of `evaluatePolicy`, and does not replace it: the receiver's tool
 * calls still pass the policy engine one by one (see `handoff-policy-hook.ts`).
 *
 * Order, first match wins (every denial carries a fixed reason code, never task text):
 *  1. the request does not match `handoffRequestSchema` (forged fields included)   -> invalid_request
 *  2. the chain does not end at the sender (a forged or stale chain)               -> invalid_request
 *  3. sender archived / receiver missing or archived                                -> sender_archived, receiver_*
 *  4. sender, receiver and chain are not all in one workspace                       -> workspace_mismatch
 *  5. the requester an agent claims differs from the stored chain's requester      -> requester_mismatch
 *  6. self handoff, cycle, depth over `MAX_HANDOFF_DEPTH`                           -> self_handoff, cycle, depth_exceeded
 *  7. widening (capability, budget, data scope) or nothing left to spend            -> widening_*, no_budget
 * Otherwise allow, with the narrowed permissions (the intersection). An allow never carries an approval.
 */
export interface HandoffRuleInput {
  readonly sender: HandoffParty;
  /** Null when the receiver does not exist (or is in no workspace the caller can see). */
  readonly receiver: HandoffParty | null;
  /** From storage. Never from agent input. */
  readonly chain: HandoffChain;
  /** A requester id the agent supplied, if any. It is only compared, never used. */
  readonly claimedRequesterMemberId?: string;
  /** The raw tool input. */
  readonly request: unknown;
}

export type HandoffDecision =
  | {
      readonly decision: "allow";
      readonly request: HandoffRequest;
      readonly permissions: NarrowedPermissions;
      readonly chain: HandoffChain;
      readonly depth: number;
    }
  | { readonly decision: "deny"; readonly reasonCode: HandoffDenialReason };

const deny = (reasonCode: HandoffDenialReason): HandoffDecision => ({
  decision: "deny",
  reasonCode,
});

export function evaluateHandoff(input: HandoffRuleInput): HandoffDecision {
  const { sender, receiver, chain } = input;

  const parsed = handoffRequestSchema.safeParse(input.request);
  if (!parsed.success) return deny("invalid_request");
  const request = parsed.data;

  if (chain.path[chain.path.length - 1] !== sender.agentId) return deny("invalid_request");
  if (sender.isArchived) return deny("sender_archived");
  if (receiver === null) return deny("receiver_not_found");
  if (receiver.agentId !== request.to_agent_id) return deny("receiver_not_found");
  if (sender.workspaceId !== receiver.workspaceId || sender.workspaceId !== chain.workspaceId) {
    return deny("workspace_mismatch");
  }
  if (receiver.isArchived) return deny("receiver_archived");
  if (
    input.claimedRequesterMemberId !== undefined &&
    input.claimedRequesterMemberId !== chain.requesterMemberId
  ) {
    return deny("requester_mismatch");
  }

  const extended = extendChain(chain, receiver.agentId);
  if (!extended.ok) return deny(extended.reason);

  const narrowed = narrowHandoff(sender, receiver, request.requested);
  if (!narrowed.ok) return deny(narrowed.reason);

  return {
    decision: "allow",
    request,
    permissions: narrowed.permissions,
    chain: extended.chain,
    depth: extended.depth,
  };
}
