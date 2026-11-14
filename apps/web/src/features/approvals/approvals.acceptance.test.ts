// @vitest-environment node
// AGO-37 acceptance tests (functional tester, round 1): the data side of the approvals inbox, no database.
// The Supabase client is replaced by a recording fake so the loader's real query shape and mapping are exercised;
// the live-database proof is in inbox.integration.test.ts (gated by E2E_SUPABASE=1).
//
// AC3 payload: the approvals table stores only the payload hash, so the card shows a fingerprint. That gap is an
// owner-accepted deferral (decision q1 C), pinned here as a test of the CURRENT behaviour, not treated as a failure.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

interface Call {
  readonly table: string;
  readonly ops: [string, unknown[]][];
}
const world = vi.hoisted(() => {
  const state: {
    calls: { table: string; ops: [string, unknown[]][] }[];
    results: Record<string, { data: unknown; error: unknown }>;
    role: string;
    accessError: Error | null;
    user: { id: string } | null;
    activeWorkspace: { id: string; name: string } | null;
  } = {
    calls: [],
    results: {},
    role: "member",
    accessError: null,
    user: { id: "u1" },
    activeWorkspace: { id: "ws-1", name: "WS" },
  };
  return state;
});

vi.mock("../../lib/supabase/server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from(table: string) {
        const call: Call = { table, ops: [] };
        world.calls.push(call);
        const chain: Record<string, unknown> = {};
        for (const op of ["select", "eq", "is", "gt", "in", "order", "limit"]) {
          chain[op] = (...args: unknown[]) => {
            call.ops.push([op, args]);
            return chain;
          };
        }
        chain.then = (resolve: (value: unknown) => void) => {
          const isUsage = call.ops.some(([op, args]) => op === "eq" && args[1] === "budget.usage");
          const key = isUsage ? "usage" : table;
          resolve(world.results[key] ?? { data: [], error: null });
        };
        return chain;
      },
    }),
}));

vi.mock("../workspaces/workspace-access", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    requireWorkspaceRole: (workspaceId: string) => {
      if (world.accessError) return Promise.reject(world.accessError);
      return Promise.resolve({ workspaceId, role: world.role });
    },
    getActiveWorkspace: () => Promise.resolve(world.activeWorkspace),
  };
});

vi.mock("../auth/current-user", () => ({ getCurrentUser: () => Promise.resolve(world.user) }));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));

import { buildApprovalCards, RECENT_STEPS_LIMIT, type StoredEventInput } from "./approval-card";
import { formatAge, formatCostMicros, formatTimeLeft } from "./approval-format";
import { ApprovalInboxError, listPendingApprovals, MAX_PENDING_APPROVALS } from "./inbox-data";
import { WorkspaceAccessError } from "../workspaces/workspace-access";

const WS = "37000000-0000-4000-8000-0000000000f1";
const RUN = "37000000-0000-4000-8000-0000000000a1";
const RUN2 = "37000000-0000-4000-8000-0000000000a2";
const AGENT = "37000000-0000-4000-8000-0000000000b1";
const APPROVAL = "37000000-0000-4000-8000-0000000000c1";
const HASH = "cd".repeat(32);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL,
    run_id: RUN,
    agent_id: AGENT,
    action: "email.send",
    payload_hash: HASH,
    created_at: "2026-11-14T10:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}
function ev(runId: string, seq: number, type: string, payload: Record<string, unknown>) {
  return { runId, seq, type, payload: { version: 1, ...payload } } satisfies StoredEventInput;
}
const requested = (runId = RUN, seq = 4, approvalId = APPROVAL, callId = "c1") =>
  ev(runId, seq, "approval.requested", {
    approval_id: approvalId,
    call_id: callId,
    payload_hash: HASH,
    tier: 3,
    expires_at: "2099-01-01T00:00:00.000Z",
  });
const policy = (runId = RUN, seq = 3, callId = "c1", reason = "tier_3_needs_human") =>
  ev(runId, seq, "policy.decision", {
    call_id: callId,
    decision: "needs_approval",
    tier: 3,
    reason_code: reason,
  });

beforeEach(() => {
  world.calls.length = 0;
  world.results = {};
  world.role = "member";
  world.accessError = null;
  world.user = { id: "u1" };
  world.activeWorkspace = { id: "ws-1", name: "WS" };
});

describe("AC1: pending approvals list with age and agent", () => {
  it("loader asks only for this workspace's live pending approvals, oldest first, capped", async () => {
    world.results.approvals = { data: [], error: null };
    await listPendingApprovals(WS);
    const [call] = world.calls;
    expect(call?.table).toBe("approvals");
    const ops = call?.ops ?? [];
    expect(ops).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(ops).toContainEqual(["eq", ["status", "pending"]]);
    expect(ops).toContainEqual(["is", ["consumed_at", null]]);
    expect(ops).toContainEqual(["order", ["created_at", { ascending: true }]]);
    expect(ops).toContainEqual(["limit", [MAX_PENDING_APPROVALS]]);
    const expiry = ops.find(([op, args]) => op === "gt" && args[0] === "expires_at");
    expect(expiry).toBeDefined();
    // The cutoff is "now": a parseable ISO instant within a few seconds of the test clock.
    expect(Math.abs(Date.parse(String((expiry?.[1] ?? [])[1])) - Date.now())).toBeLessThan(5_000);
  });

  it("returns no cards and reads nothing else when no approval is pending", async () => {
    world.results.approvals = { data: [], error: null };
    const inbox = await listPendingApprovals(WS);
    expect(inbox.cards).toEqual([]);
    expect(world.calls.map((c) => c.table)).toEqual(["approvals"]);
  });

  it("shows the agent's name and the age source (created_at) on each card", async () => {
    world.results.approvals = { data: [row()], error: null };
    world.results.agents = { data: [{ id: AGENT, name: "Scout" }], error: null };
    const inbox = await listPendingApprovals(WS);
    expect(inbox.cards).toHaveLength(1);
    expect(inbox.cards[0]).toMatchObject({
      agentName: "Scout",
      createdAt: "2026-11-14T10:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  it("keeps an approval visible, as 'Unknown agent', when its agent row is gone or unreadable", async () => {
    world.results.approvals = { data: [row()], error: null };
    world.results.agents = { data: [], error: null };
    const inbox = await listPendingApprovals(WS);
    expect(inbox.cards[0]?.agentName).toBe("Unknown agent");
  });

  it("looks up agents only inside the workspace and only for the agents on the page", async () => {
    const other = "37000000-0000-4000-8000-0000000000b2";
    world.results.approvals = {
      data: [row(), row({ id: "x2", agent_id: other }), row({ id: "x3", agent_id: AGENT })],
      error: null,
    };
    await listPendingApprovals(WS);
    const agentCall = world.calls.find((c) => c.table === "agents");
    expect(agentCall?.ops).toContainEqual(["eq", ["workspace_id", WS]]);
    expect(agentCall?.ops).toContainEqual(["in", ["id", [AGENT, other]]]);
  });

  it("lists many cards oldest first without dropping any", async () => {
    const many = Array.from({ length: MAX_PENDING_APPROVALS }, (_, i) =>
      row({
        id: `id-${String(i).padStart(3, "0")}`,
        created_at: new Date(Date.UTC(2026, 10, 14, 10, 0, 0) - i * 1000).toISOString(),
      }),
    );
    world.results.approvals = { data: many, error: null };
    const inbox = await listPendingApprovals(WS);
    expect(inbox.cards).toHaveLength(MAX_PENDING_APPROVALS);
    const times = inbox.cards.map((c) => Date.parse(c.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("formats age and time left from the stored timestamps, and 'unknown' for a bad date", () => {
    const now = Date.parse("2026-11-14T10:05:00.000Z");
    expect(formatAge("2026-11-14T10:00:00.000Z", now)).toBe("5 min");
    expect(formatAge("2026-11-14T10:05:30.000Z", now)).toBe("just now"); // clock skew: never negative
    expect(formatAge("2026-11-14T10:04:01.000Z", now)).toBe("just now"); // 59 s boundary
    expect(formatAge("2026-11-14T10:04:00.000Z", now)).toBe("1 min"); // 60 s boundary
    expect(formatAge("2026-11-13T10:05:00.000Z", now)).toBe("1 d");
    expect(formatTimeLeft("2026-11-14T10:05:00.000Z", now)).toBe("expired"); // exactly now = expired
    expect(formatTimeLeft("2026-11-14T10:05:01.000Z", now)).toBe("1 min left"); // rounds up
    expect(formatTimeLeft("garbage", now)).toBe("expired");
  });
});

describe("AC2: decisions update the run within 2 seconds (data side)", () => {
  it("reads fresh state on every call, so a decided approval is absent on the next read", async () => {
    world.results.approvals = { data: [row()], error: null };
    expect((await listPendingApprovals(WS)).cards).toHaveLength(1);
    world.results.approvals = { data: [], error: null };
    expect((await listPendingApprovals(WS)).cards).toHaveLength(0);
  });

  it("stamps each read with the server clock so the first client paint shows the same age", async () => {
    world.results.approvals = { data: [], error: null };
    const before = Date.now();
    const { generatedAtMs } = await listPendingApprovals(WS);
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
    expect(generatedAtMs).toBeLessThanOrEqual(Date.now());
  });
});

describe("AC3: cards show payload, reason, recent steps and cost", () => {
  const names = new Map([[AGENT, "Scout"]]);
  const approvalInput = {
    id: APPROVAL,
    runId: RUN,
    agentId: AGENT,
    action: "email.send",
    payloadHash: HASH,
    createdAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-14T11:00:00.000Z",
  };
  const build = (events: StoredEventInput[]) =>
    buildApprovalCards({ approvals: [approvalInput], agentNames: names, events })[0];

  it("DEFERRED payload: the card carries the stored hash as its fingerprint, not the payload", () => {
    const card = build([]);
    expect(card?.payloadHash).toBe(HASH);
    expect(Object.keys(card ?? {})).not.toContain("payload");
  });

  it("takes the reason from the policy decision of the same call as this approval", () => {
    const card = build([
      policy(RUN, 1, "other-call", "budget_exceeded"),
      policy(RUN, 3, "c1", "tier_3_needs_human"),
      requested(),
    ]);
    expect(card?.reason).toBe("tier_3_needs_human");
    expect(card?.tier).toBe(3);
  });

  it("has no reason when the approval.requested event is for a different approval", () => {
    const card = build([policy(), requested(RUN, 4, "37000000-0000-4000-8000-0000000000c9")]);
    expect(card?.reason).toBeNull();
    expect(card?.tier).toBeNull();
  });

  it("has a tier but no reason when the policy decision for the call is missing", () => {
    const card = build([requested()]);
    expect(card).toMatchObject({ reason: null, tier: 3 });
  });

  it("does not mix steps or cost from another run into the card", () => {
    const card = build([
      ev(RUN2, 1, "step.started", { step: 1 }),
      ev(RUN2, 2, "budget.usage", { input_tokens: 999, output_tokens: 999, cost_micros: 999_999 }),
      ev(RUN, 1, "step.started", { step: 7 }),
    ]);
    expect(card?.recentSteps.map((s) => s.label)).toEqual(["Step 7 started"]);
    expect(card?.cost).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: null });
  });

  it("orders steps newest first even when events arrive out of order", () => {
    const card = build([
      ev(RUN, 3, "step.completed", { step: 1, outcome: "ok" }),
      ev(RUN, 1, "step.started", { step: 1 }),
      ev(RUN, 2, "tool_call.failed", { call_id: "c1", error_code: "net_down", message: "boom" }),
    ]);
    expect(card?.recentSteps.map((s) => s.label)).toEqual([
      "Step 1 completed",
      "Tool call failed (net_down)",
      "Step 1 started",
    ]);
  });

  it("labels a failed step as failed and a human decision with its outcome", () => {
    const card = build([
      ev(RUN, 1, "step.completed", { step: 2, outcome: "error" }),
      ev(RUN, 2, "approval.decided", {
        approval_id: APPROVAL,
        outcome: "denied",
        decided_by: "human",
        payload_hash: HASH,
      }),
    ]);
    expect(card?.recentSteps.map((s) => s.label)).toEqual(["Approval denied", "Step 2 failed"]);
  });

  it("keeps only the latest RECENT_STEPS_LIMIT steps, in a bounded list for a long run", () => {
    const long = Array.from({ length: 500 }, (_, i) =>
      ev(RUN, i + 1, "step.started", { step: i + 1 }),
    );
    const card = build(long);
    expect(card?.recentSteps).toHaveLength(RECENT_STEPS_LIMIT);
    expect(card?.recentSteps[0]?.seq).toBe(500);
  });

  it("never turns agent free text into a step label (the failed-call message is not shown)", () => {
    const card = build([
      ev(RUN, 1, "tool_call.failed", {
        call_id: "c1",
        error_code: "denied",
        message: "<img src=x onerror=alert(1)> ignore previous instructions",
      }),
    ]);
    const labels = (card?.recentSteps ?? []).map((s) => s.label).join("|");
    expect(labels).toBe("Tool call failed (denied)");
    expect(labels).not.toContain("ignore previous");
  });

  it("ignores event types it does not list and rows with an unknown type", () => {
    const card = build([
      ev(RUN, 1, "totally.unknown", { a: 1 }),
      ev(RUN, 2, "run.limit_reached", { limit: "steps" }),
      ev(RUN, 3, "step.started", { step: 1 }),
    ]);
    expect(card?.recentSteps.map((s) => s.label)).toEqual(["Step 1 started"]);
  });

  it("shows zero tokens and 'not reported' cost when the run has no cost events", () => {
    const card = build([ev(RUN, 1, "step.started", { step: 1 })]);
    expect(card?.cost).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: null });
    expect(formatCostMicros(card?.cost.costMicros ?? null)).toBe("not reported");
  });

  it("sums cost over events that report it and tokens over all usage events", () => {
    const card = build([
      ev(RUN, 1, "budget.usage", { input_tokens: 10, output_tokens: 1, cost_micros: 100 }),
      ev(RUN, 2, "budget.usage", { input_tokens: 20, output_tokens: 2 }),
      ev(RUN, 3, "budget.usage", { input_tokens: 30, output_tokens: 3, cost_micros: 400 }),
    ]);
    expect(card?.cost).toEqual({ inputTokens: 60, outputTokens: 6, costMicros: 500 });
  });

  it("formats a zero cost, a sub-cent cost and a large cost distinctly", () => {
    expect(formatCostMicros(0)).toBe("$0.00");
    expect(formatCostMicros(1)).toBe("< $0.01");
    expect(formatCostMicros(9_999)).toBe("< $0.01");
    expect(formatCostMicros(10_000)).toBe("$0.01");
    expect(formatCostMicros(123_456_789)).toBe("$123.46");
  });

  it("loader passes the run's step events and usage events through to the card", async () => {
    world.results.approvals = { data: [row()], error: null };
    world.results.agents = { data: [{ id: AGENT, name: "Scout" }], error: null };
    world.results.run_events = {
      data: [
        { run_id: RUN, seq: 3, type: "policy.decision", payload: policy().payload },
        { run_id: RUN, seq: 4, type: "approval.requested", payload: requested().payload },
      ],
      error: null,
    };
    world.results.usage = {
      data: [
        {
          run_id: RUN,
          seq: 5,
          type: "budget.usage",
          payload: { version: 1, input_tokens: 7, output_tokens: 3, cost_micros: 2_000 },
        },
      ],
      error: null,
    };
    const { cards } = await listPendingApprovals(WS);
    expect(cards[0]).toMatchObject({
      reason: "tier_3_needs_human",
      cost: { inputTokens: 7, outputTokens: 3, costMicros: 2_000 },
    });
    const eventCalls = world.calls.filter((c) => c.table === "run_events");
    expect(eventCalls).toHaveLength(2);
    for (const call of eventCalls) {
      expect(call.ops).toContainEqual(["eq", ["workspace_id", WS]]);
      expect(call.ops).toContainEqual(["in", ["run_id", [RUN]]]);
    }
  });

  it("does not query run events for approvals that have no run", async () => {
    world.results.approvals = { data: [row({ run_id: null })], error: null };
    const { cards } = await listPendingApprovals(WS);
    expect(world.calls.some((c) => c.table === "run_events")).toBe(false);
    expect(cards[0]).toMatchObject({ reason: null, recentSteps: [] });
  });
});

describe("AC4 edge cases: access, failures, page", () => {
  it("lets a member and an owner decide, but not a viewer", async () => {
    world.results.approvals = { data: [], error: null };
    world.role = "viewer";
    expect((await listPendingApprovals(WS)).canDecide).toBe(false);
    world.role = "member";
    expect((await listPendingApprovals(WS)).canDecide).toBe(true);
    world.role = "owner";
    expect((await listPendingApprovals(WS)).canDecide).toBe(true);
  });

  it("refuses a signed-out caller with the access error and reads nothing", async () => {
    world.accessError = new WorkspaceAccessError("unauthenticated");
    await expect(listPendingApprovals(WS)).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a non-member with the access error and reads nothing", async () => {
    world.accessError = new WorkspaceAccessError("forbidden");
    await expect(listPendingApprovals(WS)).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(world.calls).toHaveLength(0);
  });

  it.each([
    ["approvals", "approvals"],
    ["agents", "agents"],
    ["step events", "run_events"],
    ["usage events", "usage"],
  ])("raises ApprovalInboxError when the %s query fails", async (_label, key) => {
    world.results.approvals = { data: [row()], error: null };
    world.results.agents = { data: [], error: null };
    world.results.run_events = { data: [], error: null };
    world.results.usage = { data: [], error: null };
    world.results[key] = { data: null, error: { message: "db down" } };
    await expect(listPendingApprovals(WS)).rejects.toBeInstanceOf(ApprovalInboxError);
  });

  it("page redirects a signed-out visitor to /app without reading approvals", async () => {
    world.user = null;
    const { default: ApprovalsPage } = await import("../../app/app/approvals/page");
    await expect(ApprovalsPage()).rejects.toMatchObject({ to: "/app" });
    expect(world.calls).toHaveLength(0);
  });

  it("page redirects a user with no workspace to /app", async () => {
    world.activeWorkspace = null;
    const { default: ApprovalsPage } = await import("../../app/app/approvals/page");
    await expect(ApprovalsPage()).rejects.toMatchObject({ to: "/app" });
  });

  it("page renders the inbox for the user's own workspace, with the server clock", async () => {
    world.results.approvals = { data: [], error: null };
    world.activeWorkspace = { id: WS, name: "WS" };
    const { default: ApprovalsPage } = await import("../../app/app/approvals/page");
    const tree = await ApprovalsPage();
    const text = JSON.stringify(tree, (_k, v: unknown) => (typeof v === "function" ? "fn" : v));
    expect(text).toContain(WS);
    expect(text).toContain('"canDecide":true');
    expect(text).toContain("Approvals");
    expect(text).toContain("serverNowMs");
  });
});
