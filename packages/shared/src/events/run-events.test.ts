import { describe, expect, it } from "vitest";

import {
  RUN_EVENT_SCHEMAS,
  RUN_EVENT_TYPES,
  isApprovalGranted,
  parseStoredRunEvent,
  runEventSchema,
  toRunEventColumns,
} from "./run-events.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const WHEN = "2026-11-06T10:00:00Z";

/** One valid sample per event type. The coverage test below fails if a type has no sample. */
const VALID: Record<string, Record<string, unknown>> = {
  "run.created": { agent_id: UUID, task_id: null },
  "run.started": {},
  "run.completed": { steps: 3, summary: "done" },
  "run.failed": { reason: "tool_error", message: "boom" },
  "run.paused": { requested_by: "human", reason: "user_pause" },
  "run.resumed": { resumed_by: "human" },
  "run.recovered": { step: 2, completed_calls: 3 },
  "run.stopped": { stopped_by: "budget", reason: "budget_exceeded" },
  "run.limit_reached": { limit: "steps", max: 20, observed: 20 },
  "run.loop_detected": { tool_name: "search", call_hash: HASH, repeat_count: 3 },
  "context.cut": {
    section: "tool_result",
    source: "tool:search#c1",
    action: "truncated",
    original_chars: 150000,
    kept_chars: 20000,
  },
  "step.started": { step: 1 },
  "step.completed": { step: 1, outcome: "ok" },
  "tool_call.requested": { call_id: "c1", tool_name: "search", tier: 1, input_hash: HASH },
  "tool_call.started": { call_id: "c1" },
  "tool_call.completed": { call_id: "c1", duration_ms: 12, output_hash: HASH },
  "tool_call.failed": { call_id: "c1", error_code: "timeout", message: "timed out" },
  "policy.decision": {
    call_id: "c1",
    decision: "needs_approval",
    tier: 3,
    reason_code: "tier3_requires_human",
  },
  "approval.requested": {
    approval_id: "a1",
    call_id: "c1",
    payload_hash: HASH,
    tier: 3,
    expires_at: WHEN,
  },
  "approval.decided": {
    approval_id: "a1",
    outcome: "approved",
    decided_by: "human",
    payload_hash: HASH,
  },
  "approval.route_rejected": {
    agent_id: UUID,
    route: "/api/approvals/a1/decision",
    method: "POST",
  },
  "budget.usage": { input_tokens: 10, output_tokens: 5 },
  "budget.exceeded": { scope: "run", limit: 100, used: 120 },
  "handoff.created": { handoff_id: "h1", to_agent_id: UUID, reason: "needs reviewer" },
  "handoff.accepted": { handoff_id: "h1", by_agent_id: UUID },
  "error.raised": { code: "internal", message: "oops", retryable: false },
  "message.emitted": { role: "agent", summary: "hello" },
};

const wrap = (type: string, payload: Record<string, unknown>) => ({ type, version: 1, payload });

describe("run event schemas", () => {
  it("defines every event in the v1 list and has a valid sample for each", () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual(Object.keys(VALID).sort());
    expect(RUN_EVENT_SCHEMAS).toHaveLength(Object.keys(VALID).length);
  });

  it.each(Object.entries(VALID))("accepts a valid %s", (type, payload) => {
    expect(runEventSchema.safeParse(wrap(type, payload)).success).toBe(true);
  });

  it.each(Object.entries(VALID))(
    "rejects %s with an unknown payload key (no smuggled secrets)",
    (type, payload) => {
      expect(
        runEventSchema.safeParse(wrap(type, { ...payload, api_key: "sk-live-123" })).success,
      ).toBe(false);
    },
  );

  it.each(Object.entries(VALID).filter(([, p]) => Object.keys(p).length > 0))(
    "rejects %s when a required field is missing",
    (type, payload) => {
      const required = Object.keys(payload).filter(
        (k) => !["summary", "output_hash", "cost_micros", "rule_id"].includes(k),
      );
      const first = required[0]!;
      const { [first]: _omit, ...rest } = payload;
      expect(runEventSchema.safeParse(wrap(type, rest)).success).toBe(false);
    },
  );

  it("rejects unknown types, wrong versions and a missing version", () => {
    expect(runEventSchema.safeParse(wrap("run.exploded", {})).success).toBe(false);
    expect(runEventSchema.safeParse({ type: "run.started", version: 2, payload: {} }).success).toBe(
      false,
    );
    expect(runEventSchema.safeParse({ type: "run.started", payload: {} }).success).toBe(false);
  });

  it("rejects bad values: negative counts, tier 5, non-sha256 hashes, bad dates, overlong text", () => {
    expect(runEventSchema.safeParse(wrap("run.completed", { steps: -1 })).success).toBe(false);
    expect(
      runEventSchema.safeParse(wrap("policy.decision", { ...VALID["policy.decision"], tier: 5 }))
        .success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse(
        wrap("tool_call.requested", { ...VALID["tool_call.requested"], input_hash: "raw args" }),
      ).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse(
        wrap("approval.requested", { ...VALID["approval.requested"], expires_at: "tomorrow" }),
      ).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse(
        wrap("message.emitted", { role: "agent", summary: "x".repeat(2001) }),
      ).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse(
        wrap("run.loop_detected", { ...VALID["run.loop_detected"], repeat_count: 1 }),
      ).success,
    ).toBe(false);
  });

  it("only a human, or an approval timeout, can resume a run; an agent never can", () => {
    expect(runEventSchema.safeParse(wrap("run.resumed", { resumed_by: "agent" })).success).toBe(
      false,
    );
    expect(runEventSchema.safeParse(wrap("run.resumed", { resumed_by: "human" })).success).toBe(
      true,
    );
    expect(runEventSchema.safeParse(wrap("run.resumed", { resumed_by: "timeout" })).success).toBe(
      true,
    );
  });
});

describe("approval.decided: expired is a deny, agents never approve", () => {
  const decided = (outcome: string, decided_by: string) =>
    wrap("approval.decided", { approval_id: "a1", outcome, decided_by, payload_hash: HASH });

  it("accepts approved/denied by a human and expired by timeout", () => {
    expect(runEventSchema.safeParse(decided("approved", "human")).success).toBe(true);
    expect(runEventSchema.safeParse(decided("denied", "human")).success).toBe(true);
    expect(runEventSchema.safeParse(decided("expired", "timeout")).success).toBe(true);
  });

  it("rejects an approval decided by timeout, and an expiry decided by a human", () => {
    expect(runEventSchema.safeParse(decided("approved", "timeout")).success).toBe(false);
    expect(runEventSchema.safeParse(decided("expired", "human")).success).toBe(false);
  });

  it("isApprovalGranted is true only for an approval", () => {
    const grant = (outcome: "approved" | "denied" | "expired") =>
      isApprovalGranted({ approval_id: "a1", outcome, decided_by: "human", payload_hash: HASH });
    expect(grant("approved")).toBe(true);
    expect(grant("denied")).toBe(false);
    expect(grant("expired")).toBe(false);
  });
});

describe("storage mapping", () => {
  it("round-trips an event through the type and payload columns", () => {
    const parsed = runEventSchema.parse(wrap("step.started", { step: 2 }));
    const columns = toRunEventColumns(parsed);
    expect(columns).toEqual({ type: "step.started", payload: { version: 1, step: 2 } });
    expect(parseStoredRunEvent(columns)).toEqual(parsed);
  });

  it("returns null for rows that do not match a schema (legacy or tampered)", () => {
    expect(parseStoredRunEvent({ type: "test", payload: {} })).toBeNull();
    expect(parseStoredRunEvent({ type: "step.started", payload: { version: 1 } })).toBeNull();
    expect(parseStoredRunEvent({ type: "step.started", payload: "x" })).toBeNull();
  });
});
