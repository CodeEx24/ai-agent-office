import { describe, expect, it } from "vitest";

import { buildApprovalCards, RECENT_STEPS_LIMIT, type StoredEventInput } from "./approval-card";
import { formatAge, formatCostMicros, formatTimeLeft } from "./approval-format";

const RUN = "37000000-0000-4000-8000-0000000000a1";
const AGENT = "37000000-0000-4000-8000-0000000000b1";
const APPROVAL = "37000000-0000-4000-8000-0000000000c1";
const HASH = "ab".repeat(32);

const approval = {
  id: APPROVAL,
  runId: RUN,
  agentId: AGENT,
  action: "email.send",
  payloadHash: HASH,
  createdAt: "2026-11-14T10:00:00.000Z",
  expiresAt: "2026-11-14T11:00:00.000Z",
};

function ev(seq: number, type: string, payload: Record<string, unknown>): StoredEventInput {
  return { runId: RUN, seq, type, payload: { version: 1, ...payload } };
}

const events: StoredEventInput[] = [
  ev(1, "step.started", { step: 1 }),
  ev(2, "tool_call.requested", {
    call_id: "c1",
    tool_name: "email.send",
    tier: 3,
    input_hash: HASH,
  }),
  ev(3, "policy.decision", {
    call_id: "c1",
    decision: "needs_approval",
    tier: 3,
    reason_code: "tier_3_needs_human",
  }),
  ev(4, "approval.requested", {
    approval_id: APPROVAL,
    call_id: "c1",
    payload_hash: HASH,
    tier: 3,
    expires_at: "2026-11-14T11:00:00.000Z",
  }),
  ev(5, "budget.usage", { input_tokens: 1000, output_tokens: 200, cost_micros: 12_345 }),
  ev(6, "budget.usage", { input_tokens: 500, output_tokens: 100, cost_micros: 5_000 }),
];

function build(overrideEvents = events) {
  return buildApprovalCards({
    approvals: [approval],
    agentNames: new Map([[AGENT, "Scout"]]),
    events: overrideEvents,
  });
}

describe("buildApprovalCards", () => {
  it("shows the agent, the policy reason, the tier, the hash, recent steps and the summed cost", () => {
    const [card] = build();
    expect(card).toMatchObject({
      id: APPROVAL,
      agentName: "Scout",
      action: "email.send",
      payloadHash: HASH,
      tier: 3,
      reason: "tier_3_needs_human",
      cost: { inputTokens: 1500, outputTokens: 300, costMicros: 17_345 },
    });
    // Newest first.
    expect(card?.recentSteps[0]?.label).toBe("Approval requested");
    expect(card?.recentSteps.map((s) => s.label)).toContain("Requested email.send (tier 3)");
    expect(card?.recentSteps.map((s) => s.label)).toContain(
      "Policy: needs approval (tier_3_needs_human)",
    );
  });

  it("lists the oldest request first and keeps an unknown agent visible", () => {
    const newer = {
      ...approval,
      id: "37000000-0000-4000-8000-0000000000c2",
      createdAt: "2026-11-14T10:30:00.000Z",
      agentId: "37000000-0000-4000-8000-0000000000b9",
    };
    const cards = buildApprovalCards({
      approvals: [newer, approval],
      agentNames: new Map([[AGENT, "Scout"]]),
      events,
    });
    expect(cards.map((c) => c.id)).toEqual([APPROVAL, newer.id]);
    expect(cards[1]?.agentName).toBe("Unknown agent");
  });

  it("skips an event row that does not match its schema instead of showing it", () => {
    const bad = ev(7, "tool_call.requested", {
      call_id: "c9",
      tool_name: "x",
      tier: 9,
      input_hash: "nope",
      extra: "<script>",
    });
    const [card] = build([...events, bad]);
    expect(card?.recentSteps.map((s) => s.label).join("|")).not.toContain("script");
    expect(card?.recentSteps.some((s) => s.seq === 7)).toBe(false);
  });

  it("has no reason, no steps and a zero cost for a card without a run", () => {
    const [card] = buildApprovalCards({
      approvals: [{ ...approval, runId: null }],
      agentNames: new Map([[AGENT, "Scout"]]),
      events,
    });
    expect(card).toMatchObject({ reason: null, tier: null, recentSteps: [] });
    expect(card?.cost).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: null });
  });

  it("reports no cost figure when usage events carry none", () => {
    const [card] = build([ev(1, "budget.usage", { input_tokens: 5, output_tokens: 6 })]);
    expect(card?.cost).toEqual({ inputTokens: 5, outputTokens: 6, costMicros: null });
  });

  it("limits the recent steps", () => {
    const many = Array.from({ length: 20 }, (_, i) => ev(i + 1, "step.started", { step: i + 1 }));
    const [card] = build(many);
    expect(card?.recentSteps).toHaveLength(RECENT_STEPS_LIMIT);
    expect(card?.recentSteps[0]?.label).toBe("Step 20 started");
  });
});

describe("approval formatting", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  it("formats the age of a request", () => {
    expect(formatAge("2026-11-14T11:59:30.000Z", now)).toBe("just now");
    expect(formatAge("2026-11-14T11:55:00.000Z", now)).toBe("5 min");
    expect(formatAge("2026-11-14T09:50:00.000Z", now)).toBe("2 h 10 min");
    expect(formatAge("2026-11-14T10:00:00.000Z", now)).toBe("2 h");
    expect(formatAge("2026-11-11T12:00:00.000Z", now)).toBe("3 d");
    expect(formatAge("not a date", now)).toBe("unknown");
  });
  it("formats the time left, and says expired once past", () => {
    expect(formatTimeLeft("2026-11-14T12:10:00.000Z", now)).toBe("10 min left");
    expect(formatTimeLeft("2026-11-14T13:30:00.000Z", now)).toBe("1 h 30 min left");
    expect(formatTimeLeft("2026-11-14T11:59:59.000Z", now)).toBe("expired");
  });
  it("formats the cost", () => {
    expect(formatCostMicros(null)).toBe("not reported");
    expect(formatCostMicros(0)).toBe("$0.00");
    expect(formatCostMicros(4)).toBe("< $0.01");
    expect(formatCostMicros(1_234_567)).toBe("$1.23");
  });
});
