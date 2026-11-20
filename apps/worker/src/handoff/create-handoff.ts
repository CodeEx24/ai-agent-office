import { randomUUID } from "node:crypto";

import { evaluateHandoff } from "../policy/handoff-rule.js";

import type { HandoffStore } from "./handoff-store.js";
import type { RunEventEmitter } from "../events/run-event-emitter.js";
import type { HandoffDenialReason } from "@ago/shared/handoff";

/**
 * Handoffs are tasks (AGO-81). `createHandoff` writes ONE task row for the receiver and emits `handoff.created`.
 * It is the only path for an agent to give work to another agent. Nothing here sends a message.
 *
 * What an agent cannot do through it (each has a test):
 * - widen: the receiver gets the intersection of both agents' permissions (`evaluateHandoff`);
 * - choose the requester: the chain comes from storage; the request schema has no such field and a claimed one is
 *   compared and refused when it differs;
 * - carry an approval: the request schema has no approval field and the narrowed set holds no approval;
 * - hand off outside its workspace, to itself, in a cycle or beyond `MAX_HANDOFF_DEPTH`.
 * The `reason` on the event is a fixed code: the task text lives only in the task row.
 */
export const HANDOFF_EVENT_REASON = "task_handoff";

export interface HandoffSender {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId: string;
}

export type CreateHandoffResult =
  | { readonly ok: true; readonly taskId: string; readonly depth: number }
  | { readonly ok: false; readonly reason: HandoffDenialReason };

export interface HandoffDeps {
  readonly store: HandoffStore;
  /** Bound to the acting agent's run. */
  readonly emitter: RunEventEmitter;
  readonly newId?: () => string;
}

export async function createHandoff(
  deps: HandoffDeps,
  sender: HandoffSender,
  input: unknown,
): Promise<CreateHandoffResult> {
  const [senderParty, chain] = await Promise.all([
    deps.store.loadParty(sender.workspaceId, sender.agentId),
    deps.store.loadChainForRun(sender.workspaceId, sender.runId),
  ]);
  if (senderParty === null) return { ok: false, reason: "sender_archived" };
  if (chain === null) return { ok: false, reason: "no_requester" };

  const toAgentId = receiverIdOf(input);
  const receiver =
    toAgentId === undefined ? null : await deps.store.loadParty(sender.workspaceId, toAgentId);

  const claimed = claimedRequesterOf(input);
  const decision = evaluateHandoff({
    sender: senderParty,
    receiver,
    chain,
    ...(claimed === undefined ? {} : { claimedRequesterMemberId: claimed }),
    request: stripClaim(input),
  });
  if (decision.decision === "deny") return { ok: false, reason: decision.reasonCode };

  const taskId = (deps.newId ?? randomUUID)();
  await deps.store.insert({
    taskId,
    workspaceId: sender.workspaceId,
    fromAgentId: sender.agentId,
    senderRunId: sender.runId,
    toAgentId: decision.request.to_agent_id,
    requesterMemberId: decision.chain.requesterMemberId,
    path: decision.chain.path,
    depth: decision.depth,
    narrowed: decision.permissions,
    title: decision.request.title,
    description: decision.request.description,
    acceptedByRunId: null,
  });
  await deps.emitter.emit({
    type: "handoff.created",
    payload: {
      handoff_id: taskId,
      to_agent_id: decision.request.to_agent_id,
      reason: HANDOFF_EVENT_REASON,
      from_agent_id: sender.agentId,
      task_id: taskId,
      on_behalf_of: decision.chain.requesterMemberId,
      depth: decision.depth,
    },
  });
  return { ok: true, taskId, depth: decision.depth };
}

export type AcceptHandoffResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "wrong_agent" | "already_accepted" };

/**
 * The receiver's run takes the handoff. Only the named receiver can accept: the sender, or any other agent, gets
 * `wrong_agent`. Accepting emits `handoff.accepted` with the requester the chain acts for.
 */
export async function acceptHandoff(
  deps: HandoffDeps,
  receiver: HandoffSender,
  taskId: string,
): Promise<AcceptHandoffResult> {
  const record = await deps.store.findByTask(receiver.workspaceId, taskId);
  if (record === null) return { ok: false, reason: "not_found" };
  if (record.toAgentId !== receiver.agentId) return { ok: false, reason: "wrong_agent" };
  const linked = await deps.store.markAccepted(receiver.workspaceId, taskId, receiver.runId);
  if (!linked) return { ok: false, reason: "already_accepted" };
  await deps.emitter.emit({
    type: "handoff.accepted",
    payload: {
      handoff_id: taskId,
      by_agent_id: receiver.agentId,
      task_id: taskId,
      on_behalf_of: record.requesterMemberId,
    },
  });
  return { ok: true };
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function receiverIdOf(input: unknown): string | undefined {
  const value = asRecord(input)?.to_agent_id;
  return typeof value === "string" ? value : undefined;
}

/** A requester an agent tried to supply under any of the names a forger would try. Only compared, never used. */
const CLAIM_FIELDS = ["requester_member_id", "requester", "on_behalf_of"] as const;

function claimedRequesterOf(input: unknown): string | undefined {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  for (const field of CLAIM_FIELDS) {
    if (field in record) {
      const value = record[field];
      return typeof value === "string" ? value : "<invalid>";
    }
  }
  return undefined;
}

/** The request with the claim fields removed, so the rule sees a clean request and compares the claim apart. */
function stripClaim(input: unknown): unknown {
  const record = asRecord(input);
  if (record === undefined) return input;
  const claimFields: readonly string[] = CLAIM_FIELDS;
  return Object.fromEntries(Object.entries(record).filter(([name]) => !claimFields.includes(name)));
}
