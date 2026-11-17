import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildApprovalCards, type ApprovalCardData, type StoredEventInput } from "./approval-card";
import { ApprovalCard } from "./ApprovalCard";
import {
  buildPayloadView,
  MAX_PAYLOAD_LINES,
  MAX_PAYLOAD_VALUE_CHARS,
  type ApprovalPayloadSource,
} from "./consequence-summary";

// AGO-54 round 2 acceptance tests (functional tester). They cover the four round-1 fixes through the server step
// (buildApprovalCards) and the real ApprovalCard. Expected values are written out here, not derived from the product.

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

function ev(seq: number, type: string, payload: Record<string, unknown>): StoredEventInput {
  return { runId: RUN, seq, type, payload: { version: 1, ...payload } };
}

const events: StoredEventInput[] = [
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
  opts: { action?: string; payload?: ApprovalPayloadSource } = {},
): ApprovalCardData {
  const [card] = buildApprovalCards({
    approvals: [{ ...approval, action: opts.action ?? approval.action }],
    agentNames: new Map([[AGENT, "Scout"]]),
    events,
    ...(opts.payload ? { payloads: new Map([[APPROVAL, opts.payload]]) } : {}),
  });
  if (!card) throw new Error("no card built");
  return card;
}

function renderCard(card: ApprovalCardData, canDecide = true) {
  return render(
    <ApprovalCard
      card={card}
      nowMs={NOW}
      canDecide={canDecide}
      isLocked={false}
      state={{ kind: "idle" }}
      onDecide={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = "\u{1F600}"; // 2 UTF-16 units
const LIMIT = MAX_PAYLOAD_VALUE_CHARS;

function storedLines(args: Record<string, string | number | object>) {
  const view = buildPayloadView({ kind: "stored", args: args as never });
  if (view.kind !== "stored") throw new Error("expected a stored view");
  return view;
}

describe("Round 2 item 1: the not-visible note shows only when the details are unavailable", () => {
  it("shows the note when the details are unavailable and the user can decide", () => {
    renderCard(buildOne());
    expect(screen.getByTestId("approval-details-note")).toHaveTextContent(
      "You can't see what this call will send or change",
    );
  });

  it("hides the note when the details are stored and the user can decide", () => {
    renderCard(buildOne({ payload: { kind: "stored", args: { to: "owner@example.test" } } }));
    expect(screen.queryByTestId("approval-details-note")).toBeNull();
    expect(screen.queryByText(/can't see what this call will send/)).toBeNull();
  });

  it("hides the note when the stored payload has no arguments", () => {
    const card = buildOne({ payload: { kind: "stored", args: {} } });
    expect(card.payload.kind).toBe("stored");
    renderCard(card);
    expect(screen.queryByTestId("approval-details-note")).toBeNull();
  });

  it("hides the note and shows the view-only message when unavailable and the user is view-only", () => {
    renderCard(buildOne(), false);
    expect(screen.queryByTestId("approval-details-note")).toBeNull();
    expect(screen.getByTestId("approval-view-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("hides the note and shows the view-only message when stored and the user is view-only", () => {
    renderCard(buildOne({ payload: { kind: "stored", args: { to: "a" } } }), false);
    expect(screen.queryByTestId("approval-details-note")).toBeNull();
    expect(screen.getByTestId("approval-view-only")).toBeInTheDocument();
  });

  it("shows the note when a stored source fails the schema, because it is treated as unavailable", () => {
    const bad = {
      kind: "stored",
      args: { fn: (() => 1) as unknown as string },
    } as ApprovalPayloadSource;
    const card = buildOne({ payload: bad });
    expect(card.payload.kind).toBe("unavailable");
    renderCard(card);
    expect(screen.getByTestId("approval-details-note")).toBeInTheDocument();
  });
});

describe("Round 2 item 2: truncation never leaves half a surrogate pair", () => {
  it("drops the whole emoji when its first half is the last kept character", () => {
    const view = storedLines({ body: "a".repeat(LIMIT - 1) + EMOJI + "tail" });
    expect(view.isTruncated).toBe(true);
    expect(view.lines[0]?.value).toBe("a".repeat(LIMIT - 1));
    expect(view.lines[0]?.value).not.toMatch(LONE_SURROGATE);
  });

  it("keeps the whole emoji when it ends exactly at the limit", () => {
    const view = storedLines({ body: "a".repeat(LIMIT - 2) + EMOJI + "tail" });
    expect(view.isTruncated).toBe(true);
    expect(view.lines[0]?.value).toBe("a".repeat(LIMIT - 2) + EMOJI);
  });

  it("does not cut anything when an emoji ends exactly at the limit and nothing follows", () => {
    const view = storedLines({ body: "a".repeat(LIMIT - 2) + EMOJI });
    expect(view.isTruncated).toBe(false);
    expect(view.lines[0]?.value).toBe("a".repeat(LIMIT - 2) + EMOJI);
  });

  it("keeps a multi-line value's earlier lines and drops a half emoji at the boundary", () => {
    const head = "first line\nsecond line\n";
    const value = head + "x".repeat(LIMIT - head.length - 1) + EMOJI + "\nlast line";
    const view = storedLines({ body: value });
    const out = view.lines[0]?.value ?? "";
    expect(out).toBe(head + "x".repeat(LIMIT - head.length - 1));
    expect(out.split("\n")).toEqual([
      "first line",
      "second line",
      "x".repeat(LIMIT - head.length - 1),
    ]);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it("handles every key independently when several keys sit on and off the boundary", () => {
    const view = storedLines({
      split: "s".repeat(LIMIT - 1) + EMOJI,
      whole: "w".repeat(LIMIT - 2) + EMOJI + "z",
      short: "ok " + EMOJI,
      allEmoji: EMOJI.repeat(LIMIT), // 2 * LIMIT units: cut at an even index, no half pair
    });
    const byKey = new Map(view.lines.map((l) => [l.key, l.value]));
    expect(byKey.get("split")).toBe("s".repeat(LIMIT - 1));
    expect(byKey.get("whole")).toBe("w".repeat(LIMIT - 2) + EMOJI);
    expect(byKey.get("short")).toBe("ok " + EMOJI);
    expect(byKey.get("allEmoji")).toBe(EMOJI.repeat(LIMIT / 2));
    for (const line of view.lines) expect(line.value).not.toMatch(LONE_SURROGATE);
  });

  it("does not leave a half emoji when a nested value is cut after JSON conversion", () => {
    const view = storedLines({ obj: { a: "n".repeat(LIMIT), b: EMOJI } });
    const out = view.lines[0]?.value ?? "";
    expect(view.isTruncated).toBe(true);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it("renders the cut value on the card with no replacement character and no lone surrogate", () => {
    const card = buildOne({
      payload: { kind: "stored", args: { body: "a".repeat(LIMIT - 1) + EMOJI + "tail" } },
    });
    const { container } = renderCard(card);
    const text = screen.getByTestId("approval-payload-lines").textContent;
    expect(text).not.toMatch(LONE_SURROGATE);
    expect(text).not.toContain("�");
    expect(text).not.toContain("tail");
    expect(container.textContent).toContain("Cut for display");
  });
});

describe("Round 2 item 3: an unknown tool name is quoted in the headline", () => {
  it.each([
    ["has a double quote", 'say "hi"'],
    ["has a curly closing quote", "evil” and more"],
    ["has single quotes", "it's.run"],
    ["has square and curly brackets", "tool[0]{x}"],
    ["has angle brackets", "a<b>c"],
    ["has a newline", "line1\nline2"],
  ])("quotes the name exactly and promises no effect when the tool name %s", (_label, tool) => {
    const card = buildOne({ action: tool });
    const expected = `Approving lets the agent run “${tool}”. What it will change depends on the call's details.`;
    expect(card.consequence.headline).toBe(expected);
    const { container } = renderCard(card);
    expect(screen.getByTestId("approval-consequence-headline").textContent).toBe(expected);
    expect(container.querySelector("script, img, a, b, i, svg")).toBeNull();
  });

  it("does not quote a known tool's headline", () => {
    const card = buildOne({ action: "email.send" });
    expect(card.consequence.headline).toBe(
      "Approving lets the agent send an email on your behalf.",
    );
    expect(card.consequence.headline).not.toContain("“");
  });

  it("treats a known tool name with different case or extra spaces as unknown and quotes it", () => {
    for (const tool of ["Email.Send", "email.send "]) {
      expect(buildOne({ action: tool }).consequence.headline).toBe(
        `Approving lets the agent run “${tool}”. What it will change depends on the call's details.`,
      );
    }
  });
});

describe("Round 2 item 4: the Cut for display paragraph is valid markup beside the list", () => {
  const longArgs = { a: "x".repeat(LIMIT + 1), b: "short" };

  it("places the cut note outside the definition list, after it, inside the call details region", () => {
    const { container } = renderCard(buildOne({ payload: { kind: "stored", args: longArgs } }));
    const dl = screen.getByTestId("approval-payload-lines");
    const region = screen.getByTestId("approval-payload");
    const note = screen.getByText(/Cut for display/);
    expect(note.tagName).toBe("P");
    expect(note.parentElement).toBe(region);
    expect(dl.contains(note)).toBe(false);
    expect(dl.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelectorAll("dl > p")).toHaveLength(0);
  });

  it("keeps every direct child of every definition list a div, even when truncated", () => {
    const { container } = renderCard(buildOne({ payload: { kind: "stored", args: longArgs } }));
    for (const dl of Array.from(container.querySelectorAll("dl"))) {
      for (const child of Array.from(dl.children)) expect(child.tagName).toBe("DIV");
    }
  });

  it("puts a dt and a dd inside each payload line div", () => {
    renderCard(buildOne({ payload: { kind: "stored", args: longArgs } }));
    const dl = screen.getByTestId("approval-payload-lines");
    expect(dl.children).toHaveLength(2);
    for (const row of Array.from(dl.children)) {
      expect(Array.from(row.children).map((c) => c.tagName)).toEqual(["DT", "DD"]);
    }
  });

  it("shows the cut note when there are more keys than the line limit", () => {
    const args = Object.fromEntries(
      Array.from({ length: MAX_PAYLOAD_LINES + 1 }, (_, i) => [`k${String(i)}`, i]),
    );
    const { container } = renderCard(buildOne({ payload: { kind: "stored", args } }));
    expect(screen.getByText(/Cut for display/)).toBeInTheDocument();
    expect(screen.getByTestId("approval-payload-lines").children).toHaveLength(MAX_PAYLOAD_LINES);
    expect(container.querySelectorAll("dl > p")).toHaveLength(0);
  });

  it("shows no cut note for a payload that fits", () => {
    renderCard(buildOne({ payload: { kind: "stored", args: { to: "a", n: 1 } } }));
    expect(screen.queryByText(/Cut for display/)).toBeNull();
  });

  it("shows no cut note and no list when the details are unavailable", () => {
    renderCard(buildOne());
    expect(screen.queryByText(/Cut for display/)).toBeNull();
    expect(screen.queryByTestId("approval-payload-lines")).toBeNull();
  });
});
