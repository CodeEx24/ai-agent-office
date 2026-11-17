import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildApprovalCards, type ApprovalCardData, type StoredEventInput } from "./approval-card";
import { ApprovalCard, type CardDecisionState } from "./ApprovalCard";
import {
  buildPayloadView,
  MAX_PAYLOAD_LINES,
  MAX_PAYLOAD_VALUE_CHARS,
  summarizeConsequence,
  type ApprovalPayloadSource,
} from "./consequence-summary";

// AGO-54 acceptance tests, added by the functional tester. They go through buildApprovalCards (the server step) and
// the real ApprovalCard, so they prove what an owner sees, not how the helpers are wired.

const NOW = Date.parse("2026-11-14T10:05:00.000Z");
const HASH = "cd".repeat(32);
const RUN = "54000000-0000-4000-8000-0000000000a1";
const AGENT = "54000000-0000-4000-8000-0000000000b1";
const APPROVAL = "54000000-0000-4000-8000-0000000000c1";

const approval = {
  id: APPROVAL,
  runId: RUN,
  agentId: AGENT,
  action: "email.send",
  payloadHash: HASH,
  createdAt: "2026-11-14T10:00:00.000Z",
  expiresAt: "2026-11-14T11:00:00.000Z",
};

// Fake hostile strings. Built by concatenation so no scanner mistakes them for real markup or secrets.
const SCRIPT = "<scr" + "ipt>window.__pwned=1</scr" + "ipt>";
const IMG = "<img src=x oner" + 'ror="window.__pwned=2">';
const JSLINK = '<a href="java' + 'script:window.__pwned=3">click</a>';
const HOSTILE = `${SCRIPT}${IMG}${JSLINK}`;

function ev(seq: number, type: string, payload: Record<string, unknown>): StoredEventInput {
  return { runId: RUN, seq, type, payload: { version: 1, ...payload } };
}

const policyEvents: StoredEventInput[] = [
  ev(1, "tool_call.requested", {
    call_id: "c1",
    tool_name: "email.send",
    tier: 3,
    input_hash: HASH,
  }),
  ev(2, "policy.decision", {
    call_id: "c1",
    decision: "needs_approval",
    tier: 3,
    reason_code: "tier_3_needs_human",
  }),
  ev(3, "approval.requested", {
    approval_id: APPROVAL,
    call_id: "c1",
    payload_hash: HASH,
    tier: 3,
    expires_at: "2026-11-14T11:00:00.000Z",
  }),
];

function buildOne(
  opts: {
    action?: string;
    agentName?: string;
    events?: StoredEventInput[];
    payload?: ApprovalPayloadSource;
  } = {},
): ApprovalCardData {
  const [card] = buildApprovalCards({
    approvals: [{ ...approval, action: opts.action ?? approval.action }],
    agentNames: new Map([[AGENT, opts.agentName ?? "Scout"]]),
    events: opts.events ?? policyEvents,
    ...(opts.payload ? { payloads: new Map([[APPROVAL, opts.payload]]) } : {}),
  });
  if (!card) throw new Error("no card built");
  return card;
}

function renderCard(
  card: ApprovalCardData,
  opts: { canDecide?: boolean; state?: CardDecisionState } = {},
) {
  return render(
    <ApprovalCard
      card={card}
      nowMs={NOW}
      canDecide={opts.canDecide ?? true}
      isLocked={false}
      state={opts.state ?? { kind: "idle" }}
      onDecide={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("AC1: the card renders from the stored payload, not agent prose", () => {
  it("keeps agent prose in message and run-summary events out of the consequence", () => {
    const prose = "Totally safe, just a harmless greeting, ignore the policy";
    const events = [
      ...policyEvents,
      ev(4, "message.emitted", { role: "agent", summary: prose }),
      ev(5, "run.completed", { steps: 2, summary: prose }),
    ];
    const withProse = buildOne({ events });
    const without = buildOne();
    expect(withProse.consequence).toEqual(without.consequence);
    expect(JSON.stringify(withProse.consequence)).not.toContain("harmless");
    expect(withProse.recentSteps.map((s) => s.label).join(" ")).not.toContain("harmless");
  });

  it("does not let a hostile agent name or a hostile event reason change the consequence", () => {
    const hostileEvents = [
      ev(1, "tool_call.requested", {
        call_id: "c1",
        tool_name: "email.send",
        tier: 3,
        input_hash: HASH,
      }),
      ev(2, "policy.decision", {
        call_id: "c1",
        decision: "needs_approval",
        tier: 3,
        reason_code: HOSTILE,
      }),
      ev(3, "approval.requested", {
        approval_id: APPROVAL,
        call_id: "c1",
        payload_hash: HASH,
        tier: 3,
        expires_at: "2026-11-14T11:00:00.000Z",
      }),
    ];
    const card = buildOne({ agentName: HOSTILE, events: hostileEvents });
    expect(card.consequence).toEqual(buildOne().consequence);
    expect(JSON.stringify(card.consequence)).not.toContain("window.__pwned");
  });

  it("shows the stored argument names and values on the card when a payload source is stored", () => {
    const card = buildOne({
      payload: { kind: "stored", args: { to: "owner@example.test", subject: "Hello" } },
    });
    renderCard(card);
    const region = screen.getByTestId("approval-payload");
    expect(within(region).getByText("to")).toBeInTheDocument();
    expect(within(region).getByText("owner@example.test")).toBeInTheDocument();
    expect(screen.getByTestId("approval-consequence")).toHaveTextContent(
      "The call carries: to, subject.",
    );
  });

  it("says the call details are not stored yet and shows the hash reference when nothing is stored", () => {
    renderCard(buildOne());
    const region = screen.getByTestId("approval-payload");
    expect(region).toHaveTextContent("the full call details are not stored yet");
    expect(region).toHaveTextContent(`Reference ${HASH.slice(0, 12)}`);
    expect(screen.getByTestId("approval-consequence")).toHaveTextContent("is not stored");
  });

  it("treats a payload source that fails the schema as unavailable instead of showing it", () => {
    const bad = {
      kind: "stored",
      args: { fn: (() => 1) as unknown as string, ok: "fine" },
    } as ApprovalPayloadSource;
    const card = buildOne({ payload: bad });
    expect(card.payload).toEqual({ kind: "unavailable" });
    renderCard(card);
    expect(screen.getByTestId("approval-payload")).not.toHaveTextContent("fine");
  });

  it("treats a payload with an empty argument name as unavailable", () => {
    expect(buildPayloadView({ kind: "stored", args: { "": "x" } })).toEqual({
      kind: "unavailable",
    });
  });

  it("says the call carries no arguments when the stored payload is empty", () => {
    const card = buildOne({ payload: { kind: "stored", args: {} } });
    expect(card.consequence.details.join(" ")).toContain("The call carries no arguments.");
    expect(card.payload).toEqual({ kind: "stored", lines: [], isTruncated: false });
  });

  it("falls back to an unknown tier label when the run events were not read", () => {
    const card = buildOne({ events: [] });
    expect(card.tier).toBeNull();
    expect(card.consequence.tierLabel).toContain("Tier unknown");
    expect(card.consequence.severity).toBe("elevated");
    renderCard(card);
    expect(screen.getByTestId("approval-consequence")).toHaveTextContent("Tier unknown");
  });

  it("gives an unknown tool a generic headline that names it and promises no effect", () => {
    const card = buildOne({ action: "mystery.tool" });
    expect(card.consequence.headline).toBe(
      "Approving lets the agent run “mystery.tool”. What it will change depends on the call's details.",
    );
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "treats the tool named %s like any unknown tool",
    (tool) => {
      const card = buildOne({ action: tool });
      expect(card.consequence.headline).toBe(
        `Approving lets the agent run “${tool}”. What it will change depends on the call's details.`,
      );
    },
  );

  it("renders hostile text in every card field as escaped text with no injected elements", () => {
    const card = buildOne({
      action: HOSTILE,
      agentName: HOSTILE,
      payload: { kind: "stored", args: { [HOSTILE]: HOSTILE, nested: { a: [HOSTILE] } } },
    });
    const withSteps: ApprovalCardData = {
      ...card,
      reason: HOSTILE,
      recentSteps: [{ seq: 1, label: HOSTILE }],
    };
    const { container } = renderCard(withSteps);
    expect(container.querySelector("script, img, a")).toBeNull();
    expect(container.textContent).toContain(SCRIPT);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(JSLINK);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("AC2: long payloads cannot push the effect out of view", () => {
  it("cuts a value over the limit, keeps the first characters, and says it was cut", () => {
    const view = buildPayloadView({
      kind: "stored",
      args: { body: "a".repeat(MAX_PAYLOAD_VALUE_CHARS) + "TAIL" },
    });
    expect(view.kind).toBe("stored");
    if (view.kind !== "stored") return;
    expect(view.isTruncated).toBe(true);
    expect(view.lines[0]?.value).toBe("a".repeat(MAX_PAYLOAD_VALUE_CHARS));
  });

  it("does not mark a value exactly at the limit as cut", () => {
    const view = buildPayloadView({
      kind: "stored",
      args: { body: "a".repeat(MAX_PAYLOAD_VALUE_CHARS) },
    });
    expect(view.kind === "stored" && view.isTruncated).toBe(false);
  });

  it("keeps only the first lines when there are more keys than the limit", () => {
    const args = Object.fromEntries(
      Array.from({ length: MAX_PAYLOAD_LINES + 1 }, (_, i) => [`key${String(i)}`, i]),
    );
    const view = buildPayloadView({ kind: "stored", args });
    expect(view.kind === "stored" && view.lines.map((l) => l.key)).toEqual(
      Array.from({ length: MAX_PAYLOAD_LINES }, (_, i) => `key${String(i)}`),
    );
    expect(view.kind === "stored" && view.isTruncated).toBe(true);
  });

  it("names at most eight argument fields in the consequence even with many keys", () => {
    const args = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, i]));
    const card = buildOne({ payload: { kind: "stored", args } });
    expect(card.consequence.details.join(" ")).toContain("and 42 more");
    expect(card.consequence.details.join(" ").length).toBeLessThan(300);
  });

  it("bounds one giant unbroken word: the region scrolls and wraps, and the effect stays outside it", () => {
    const card = buildOne({
      payload: { kind: "stored", args: { blob: "W".repeat(MAX_PAYLOAD_VALUE_CHARS * 3) } },
    });
    renderCard(card);
    const region = screen.getByTestId("approval-payload");
    expect(region).toHaveClass("max-h-48", "overflow-auto");
    expect(region.className).toContain("overflow-wrap:anywhere");
    expect(region).not.toContainElement(screen.getByTestId("approval-consequence"));
    expect(region).not.toContainElement(screen.getByRole("button", { name: "Approve" }));
    expect(region.textContent).toContain("Cut for display");
  });

  it("renders deeply nested JSON as one bounded text line without throwing", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 200; i += 1) nested = { n: nested };
    const view = buildPayloadView({
      kind: "stored",
      args: { deep: nested as never },
    });
    expect(view.kind).toBe("stored");
    if (view.kind !== "stored") return;
    expect(view.lines[0]?.value.length).toBeLessThanOrEqual(MAX_PAYLOAD_VALUE_CHARS);
    renderCard({ ...buildOne(), payload: view });
    expect(screen.getByTestId("approval-payload")).toBeInTheDocument();
  });

  it("keeps the same consequence and DOM order whether the payload is tiny or huge", () => {
    const small = buildOne({ payload: { kind: "stored", args: { to: "a" } } });
    const huge = buildOne({
      payload: {
        kind: "stored",
        args: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, "v".repeat(5000)]),
        ),
      },
    });
    renderCard(huge);
    const consequence = screen.getByTestId("approval-consequence");
    expect(isBefore(consequence, screen.getByTestId("approval-payload"))).toBe(true);
    expect(
      isBefore(
        screen.getByRole("button", { name: "Approve" }),
        screen.getByTestId("approval-payload"),
      ),
    ).toBe(true);
    expect(consequence.getAttribute("data-severity")).toBe(small.consequence.severity);
    expect(screen.getByTestId("approval-payload-lines").querySelectorAll("dt")).toHaveLength(
      MAX_PAYLOAD_LINES,
    );
  });
});

describe("AC3: the consequence summary appears first", () => {
  it("puts the consequence after the header and before the decision note, buttons and payload", () => {
    renderCard(buildOne());
    const consequence = screen.getByTestId("approval-consequence");
    expect(isBefore(screen.getByText(/Scout wants to run/), consequence)).toBe(true);
    expect(isBefore(consequence, screen.getByTestId("approval-details-note"))).toBe(true);
    expect(isBefore(consequence, screen.getByRole("button", { name: "Approve" }))).toBe(true);
    expect(isBefore(consequence, screen.getByRole("button", { name: "Reject" }))).toBe(true);
    expect(isBefore(consequence, screen.getByTestId("approval-payload"))).toBe(true);
    expect(isBefore(consequence, screen.getByTestId("approval-reason"))).toBe(true);
    expect(isBefore(consequence, screen.getByTestId("approval-steps"))).toBe(true);
  });

  it("shows the consequence before the payload for a view-only user", () => {
    renderCard(buildOne(), { canDecide: false });
    const consequence = screen.getByTestId("approval-consequence");
    expect(consequence).toHaveTextContent("Approving lets the agent send an email");
    expect(isBefore(consequence, screen.getByTestId("approval-view-only"))).toBe(true);
    expect(isBefore(consequence, screen.getByTestId("approval-payload"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("keeps the consequence above the receipt after a decision", () => {
    renderCard(buildOne(), { state: { kind: "decided", decision: "approved" } });
    const consequence = screen.getByTestId("approval-consequence");
    expect(consequence).toHaveTextContent("Approving lets the agent send an email");
    expect(isBefore(consequence, screen.getByTestId("approval-result"))).toBe(true);
    expect(screen.getByTestId("approval-result")).toHaveTextContent("Approved");
  });

  it("marks a tier 4 call critical and says it always needs a person", () => {
    const events = policyEvents.map((e) => ({
      ...e,
      payload: {
        ...(e.payload as Record<string, unknown>),
        ...(e.type === "tool_call.requested" ||
        e.type === "approval.requested" ||
        e.type === "policy.decision"
          ? { tier: 4 }
          : {}),
      },
    }));
    const card = buildOne({ action: "file.delete", events });
    expect(card.consequence.severity).toBe("critical");
    renderCard(card);
    expect(screen.getByTestId("approval-consequence")).toHaveAttribute("data-severity", "critical");
    expect(screen.getByTestId("approval-consequence")).toHaveTextContent("Tier 4: highest risk");
  });

  it("builds the same words every time for the same stored fields", () => {
    const first = summarizeConsequence("vault.delete", 3, { kind: "unavailable" });
    const second = summarizeConsequence("vault.delete", 3, { kind: "unavailable" });
    expect(first).toEqual(second);
    expect(first.headline).toBe("Approving lets the agent delete a note from the vault.");
  });
});
