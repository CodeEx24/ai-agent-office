import { parseStoredRunEvent, type RunEvent } from "@ago/shared";

import {
  buildPayloadView,
  summarizeConsequence,
  type ApprovalPayloadSource,
  type ApprovalPayloadView,
  type ConsequenceSummary,
} from "./consequence-summary";

/**
 * What one card in the approvals inbox shows (AGO-37). Pure: no I/O, so it is tested without a database.
 *
 * Everything here comes from STORED, structured data: the `approvals` row and validated run events (type and
 * payload checked by `parseStoredRunEvent`). Event payloads hold hashes, counts and codes, never raw tool input,
 * so the card shows tool name, tier, hash and reason code, not the call's arguments. The full payload is a deferred
 * acceptance criterion (the approvals table stores only its hash). Nothing here is HTML: the UI renders every field
 * as inert text.
 */

/** How many of the run's latest steps a card lists. */
export const RECENT_STEPS_LIMIT = 6;

export interface ApprovalRowInput {
  readonly id: string;
  readonly runId: string | null;
  readonly agentId: string;
  readonly action: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoredEventInput {
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface ApprovalStep {
  readonly seq: number;
  /** A short label built from event fields (type, step number, tool name), never from free text. */
  readonly label: string;
}

export interface ApprovalCardData {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly runId: string | null;
  readonly action: string;
  readonly payloadHash: string;
  readonly tier: number | null;
  /** The policy's reason code for the call that needs approval; null when it cannot be found. */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** What approving will do (AGO-54): built on the server from the tool, tier and stored arguments, never agent prose. */
  readonly consequence: ConsequenceSummary;
  /** The call details for the card's bounded payload region; `unavailable` until AGO-215 stores the payload. */
  readonly payload: ApprovalPayloadView;
  readonly recentSteps: readonly ApprovalStep[];
  /**
   * True when the events were read only in part and this card has no reason or no steps: they may exist but were not
   * read. The card then says "may be incomplete" instead of "Not recorded" / "No steps recorded".
   */
  readonly isHistoryIncomplete: boolean;
  readonly cost: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Millionths of a dollar; null when the run reported no cost figure. */
    readonly costMicros: number | null;
    /** True when the run has more usage events than were read, so the totals are a lower bound. */
    readonly isPartial: boolean;
  };
}

/** One cent in micros (millionths of a dollar). The worker reports `cost_cents` (AGO-40), so that is converted. */
const MICROS_PER_CENT = 10_000;

/** A usage event's cost in micros: `cost_micros` when present, else `cost_cents` converted. Each event counts once. */
function costMicrosOf(payload: { cost_micros?: number; cost_cents?: number }): number | null {
  if (payload.cost_micros !== undefined) return payload.cost_micros;
  if (payload.cost_cents !== undefined) return payload.cost_cents * MICROS_PER_CENT;
  return null;
}

function stepLabel(event: RunEvent): string | null {
  switch (event.type) {
    case "step.started":
      return `Step ${String(event.payload.step)} started`;
    case "step.completed":
      return `Step ${String(event.payload.step)} ${event.payload.outcome === "ok" ? "completed" : "failed"}`;
    case "tool_call.requested":
      return `Requested ${event.payload.tool_name} (tier ${String(event.payload.tier)})`;
    case "tool_call.completed":
      return "Tool call completed";
    case "tool_call.failed":
      return `Tool call failed (${event.payload.error_code})`;
    case "policy.decision":
      return `Policy: ${event.payload.decision.replace("_", " ")} (${event.payload.reason_code})`;
    case "approval.requested":
      return "Approval requested";
    case "approval.decided":
      return `Approval ${event.payload.outcome}`;
    case "run.paused":
      return "Run paused";
    case "run.resumed":
      return "Run resumed";
    default:
      return null;
  }
}

interface ParsedEvent {
  readonly seq: number;
  readonly event: RunEvent;
}

function parseEvents(events: readonly StoredEventInput[]): Map<string, ParsedEvent[]> {
  const byRun = new Map<string, ParsedEvent[]>();
  for (const row of [...events].sort((a, b) => a.seq - b.seq)) {
    const event = parseStoredRunEvent({ type: row.type, payload: row.payload });
    // A row that does not match its schema is skipped, never shown.
    if (!event) continue;
    const list = byRun.get(row.runId) ?? [];
    list.push({ seq: row.seq, event });
    byRun.set(row.runId, list);
  }
  return byRun;
}

/** The policy reason and tier for this approval: the `approval.requested` event names the call, the policy event gives the reason. */
function reasonFor(
  approvalId: string,
  events: readonly ParsedEvent[],
): { reason: string | null; tier: number | null } {
  const requested = events.find(
    (item) =>
      item.event.type === "approval.requested" && item.event.payload.approval_id === approvalId,
  )?.event;
  if (requested?.type !== "approval.requested") return { reason: null, tier: null };
  const policy = events.find(
    (item) =>
      item.event.type === "policy.decision" &&
      item.event.payload.call_id === requested.payload.call_id,
  )?.event;
  return {
    reason: policy?.type === "policy.decision" ? policy.payload.reason_code : null,
    tier: requested.payload.tier,
  };
}

function costFor(events: readonly ParsedEvent[], isPartial: boolean): ApprovalCardData["cost"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros: number | null = null;
  for (const { event } of events) {
    if (event.type !== "budget.usage") continue;
    inputTokens += event.payload.input_tokens;
    outputTokens += event.payload.output_tokens;
    const eventMicros = costMicrosOf(event.payload);
    if (eventMicros !== null) {
      costMicros = (costMicros ?? 0) + eventMicros;
    }
  }
  return { inputTokens, outputTokens, costMicros, isPartial };
}

function recentStepsFor(events: readonly ParsedEvent[]): ApprovalStep[] {
  const steps: ApprovalStep[] = [];
  for (const { seq, event } of events) {
    const label = stepLabel(event);
    if (label !== null) steps.push({ seq, label });
  }
  return steps.slice(-RECENT_STEPS_LIMIT).reverse();
}

/**
 * Builds the cards, oldest request first (the one waiting longest is on top). An approval whose agent is unknown
 * still shows, with a neutral name, so a pending request is never hidden.
 */
export function buildApprovalCards(input: {
  readonly approvals: readonly ApprovalRowInput[];
  readonly agentNames: ReadonlyMap<string, string>;
  readonly events: readonly StoredEventInput[];
  /** Runs whose usage events were cut short when read: their cost is marked partial. */
  readonly partialCostRunIds?: ReadonlySet<string>;
  /** True when the decision or step reads were cut short, so a missing reason or step list may just be unread. */
  readonly isHistoryCut?: boolean;
  /** The stored call arguments by approval id (AGO-215 fills this); an approval with no entry has none stored. */
  readonly payloads?: ReadonlyMap<string, ApprovalPayloadSource>;
}): ApprovalCardData[] {
  const byRun = parseEvents(input.events);
  return [...input.approvals]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((approval) => {
      const events = approval.runId ? (byRun.get(approval.runId) ?? []) : [];
      const { reason, tier } = reasonFor(approval.id, events);
      const recentSteps = recentStepsFor(events);
      const payload = input.payloads?.get(approval.id) ?? { kind: "unavailable" as const };
      const isPartial =
        approval.runId !== null && (input.partialCostRunIds?.has(approval.runId) ?? false);
      return {
        id: approval.id,
        agentId: approval.agentId,
        agentName: input.agentNames.get(approval.agentId) ?? "Unknown agent",
        runId: approval.runId,
        action: approval.action,
        payloadHash: approval.payloadHash,
        tier,
        reason,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
        consequence: summarizeConsequence(approval.action, tier, payload),
        payload: buildPayloadView(payload),
        recentSteps,
        isHistoryIncomplete:
          (input.isHistoryCut ?? false) && (reason === null || recentSteps.length === 0),
        cost: costFor(events, isPartial),
      };
    });
}
