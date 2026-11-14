import { parseStoredRunEvent, type RunEvent } from "@ago/shared";

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
  readonly recentSteps: readonly ApprovalStep[];
  readonly cost: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Millionths of a dollar; null when the run reported no cost figure. */
    readonly costMicros: number | null;
  };
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

function costFor(events: readonly ParsedEvent[]): ApprovalCardData["cost"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros: number | null = null;
  for (const { event } of events) {
    if (event.type !== "budget.usage") continue;
    inputTokens += event.payload.input_tokens;
    outputTokens += event.payload.output_tokens;
    if (event.payload.cost_micros !== undefined) {
      costMicros = (costMicros ?? 0) + event.payload.cost_micros;
    }
  }
  return { inputTokens, outputTokens, costMicros };
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
}): ApprovalCardData[] {
  const byRun = parseEvents(input.events);
  return [...input.approvals]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((approval) => {
      const events = approval.runId ? (byRun.get(approval.runId) ?? []) : [];
      const { reason, tier } = reasonFor(approval.id, events);
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
        recentSteps: recentStepsFor(events),
        cost: costFor(events),
      };
    });
}
