// AGO-37 acceptance tests (functional tester, round 1): the inbox UI behaviour the existing component test does not
// cover: failure states per HTTP status, many cards, independent decisions, polling rules, inert rendering of every
// field, and the viewer path.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import type { ApprovalCardData } from "./approval-card";
import { ApprovalInbox, INBOX_REFRESH_MS } from "./ApprovalInbox";

const WORKSPACE = "37000000-0000-4000-8000-0000000000f1";
const NOW = Date.parse("2026-11-14T10:05:00.000Z");

function makeCard(n: number, overrides: Partial<ApprovalCardData> = {}): ApprovalCardData {
  return {
    id: `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    agentId: "37000000-0000-4000-8000-0000000000b1",
    agentName: `Agent ${String(n)}`,
    runId: "37000000-0000-4000-8000-0000000000a1",
    action: "email.send",
    payloadHash: "ab".repeat(32),
    tier: 3,
    reason: "tier_3_needs_human",
    createdAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-14T11:00:00.000Z",
    recentSteps: [{ seq: 1, label: "Approval requested" }],
    cost: { inputTokens: 0, outputTokens: 0, costMicros: null },
    ...overrides,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  refresh.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

function setup(cards: ApprovalCardData[], canDecide = true) {
  return render(
    <ApprovalInbox workspaceId={WORKSPACE} cards={cards} canDecide={canDecide} serverNowMs={NOW} />,
  );
}

describe("AC1: pending list shows age and agent for every card", () => {
  it("renders one card per approval, each with its own agent and age", () => {
    const cards = [
      makeCard(1, { agentName: "Scout", createdAt: "2026-11-14T10:00:00.000Z" }),
      makeCard(2, { agentName: "Writer", createdAt: "2026-11-14T09:05:00.000Z" }),
    ];
    setup(cards);
    const items = screen.getAllByTestId("approval-card");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(/Scout wants to run/)).toBeInTheDocument();
    expect(within(items[0]!).getByTestId("approval-age")).toHaveTextContent("Waiting 5 min");
    expect(within(items[1]!).getByText(/Writer wants to run/)).toBeInTheDocument();
    expect(within(items[1]!).getByTestId("approval-age")).toHaveTextContent(/^Waiting 1 h$/);
  });

  it("shows an unknown agent by its neutral name", () => {
    setup([makeCard(1, { agentName: "Unknown agent" })]);
    expect(screen.getByText(/Unknown agent wants to run/)).toBeInTheDocument();
  });

  it("renders 50 cards, each with Approve and Reject, and one list landmark", () => {
    setup(Array.from({ length: 50 }, (_, i) => makeCard(i + 1)));
    expect(screen.getAllByTestId("approval-card")).toHaveLength(50);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(50);
    expect(screen.getAllByRole("list", { name: "Pending approvals" })).toHaveLength(1);
  });

  it("shows 'expired' on a card whose time ran out between reads", () => {
    setup([makeCard(1, { expiresAt: "2026-11-14T10:05:00.000Z" })]);
    expect(screen.getByTestId("approval-time-left")).toHaveTextContent("expired");
  });

  it("advances the shown age on the poll tick without a server round trip", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setup([makeCard(1)]);
    expect(screen.getByTestId("approval-age")).toHaveTextContent("Waiting 5 min");
    act(() => {
      vi.setSystemTime(NOW + 3 * 60_000);
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(screen.getByTestId("approval-age")).toHaveTextContent("Waiting 8 min");
  });

  it("shows the empty state with no cards and no list", () => {
    setup([]);
    expect(screen.getByTestId("approvals-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("approvals-list")).not.toBeInTheDocument();
  });
});

describe("AC2: decisions update the run within 2 seconds (UI side)", () => {
  it("does not poll the server while the tab is hidden, and resumes when visible", () => {
    vi.useFakeTimers();
    setup([makeCard(1)]);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops polling after the inbox unmounts", () => {
    vi.useFakeTimers();
    const { unmount } = setup([makeCard(1)]);
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks for a fresh list straight after a decision lands, and shows the verdict at once", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup([makeCard(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("approval-result")).toHaveTextContent("Approved");
  });

  it("disables both buttons while the decision is in flight and posts once on a double click", async () => {
    let finish: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    setup([makeCard(1)]);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("approval-result")).toBeInTheDocument();
    });
  });

  it("decides only the card that was clicked and leaves the others untouched", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const cards = [makeCard(1), makeCard(2), makeCard(3)];
    setup(cards);
    const second = screen.getAllByTestId("approval-card")[1]!;
    fireEvent.click(within(second).getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(within(second).getByTestId("approval-result")).toHaveTextContent("Rejected");
    });
    expect(screen.getAllByTestId("approval-result")).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/approvals/${cards[1]?.id ?? ""}/decision`);
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: WORKSPACE,
      decision: "denied",
    });
    const first = screen.getAllByTestId("approval-card")[0]!;
    expect(within(first).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("keeps a decided card showing its verdict if the next read still lists it, never offering a second decision", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup([makeCard(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByTestId("approval-result");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});

describe("AC4 edge cases: failure states, viewer, hostile text", () => {
  it.each([
    [404, "can no longer be decided"],
    [401, "not allowed"],
    [403, "not allowed"],
    [500, "Could not record the decision"],
    [503, "Could not record the decision"],
    [409, "Could not record the decision"],
  ])("shows a readable message for HTTP %i and lets the person try again", async (status, text) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    setup([makeCard(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByTestId("approval-result")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("shows a network-failure message and recovers on a second try", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    setup([makeCard(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(screen.getByTestId("approval-result")).toHaveTextContent("Approved");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never leaks the response body or status text into the failure message", async () => {
    fetchMock.mockResolvedValue(
      new Response("SQLSTATE 42P01 secret detail", { status: 500, statusText: "Boom" }),
    );
    setup([makeCard(1)]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("SQLSTATE");
    expect(alert).not.toHaveTextContent("Boom");
  });

  it("gives a viewer a read-only card: all fields, no decide buttons, no request ever sent", () => {
    setup([makeCard(1), makeCard(2)], false);
    expect(screen.getAllByTestId("approval-card")).toHaveLength(2);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByText("Only members can decide an approval.")).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders no-cost cards as 'not reported' with zero tokens", () => {
    setup([makeCard(1)]);
    expect(screen.getByTestId("approval-cost")).toHaveTextContent("not reported");
    expect(screen.getByTestId("approval-cost")).toHaveTextContent("0 tokens");
  });

  it("says 'Not recorded' when the reason is unknown and 'No steps recorded.' when there are none", () => {
    setup([makeCard(1, { reason: null, tier: null, recentSteps: [] })]);
    expect(screen.getByTestId("approval-reason")).toHaveTextContent("Not recorded");
    expect(screen.getByText("No steps recorded.")).toBeInTheDocument();
    expect(screen.queryByText(/Tier \d/)).not.toBeInTheDocument();
  });

  it("shows the whole payload hash on hover and only a short fingerprint in the text", () => {
    const hash = "0123456789abcdef".repeat(4);
    setup([makeCard(1, { payloadHash: hash })]);
    const code = within(screen.getByTestId("approval-payload")).getByText("0123456789ab…");
    expect(code).toHaveAttribute("title", hash);
    expect(screen.getByTestId("approval-payload")).not.toHaveTextContent(hash);
  });

  it("renders every untrusted field inert: name, action, reason, step labels and the hash", () => {
    const evil = {
      agentName: '"><svg onload=alert(1)>',
      action: "<iframe src=javascript:alert(2)>",
      reason: "<style>body{display:none}</style>",
      payloadHash: "<script>alert(3)</script>".padEnd(64, "x"),
      recentSteps: [
        { seq: 1, label: "<a href=javascript:alert(4)>go</a>" },
        { seq: 2, label: "&lt;b&gt;already escaped&lt;/b&gt;" },
      ],
    };
    const { container } = setup([makeCard(1, evil)]);
    expect(container.querySelector("svg, iframe, style, script, a, img, b")).toBeNull();
    expect(container).toHaveTextContent('"><svg onload=alert(1)>');
    expect(container).toHaveTextContent("<iframe src=javascript:alert(2)>");
    expect(container).toHaveTextContent("<style>body{display:none}</style>");
    // Entities are shown as typed, not decoded.
    expect(container).toHaveTextContent("&lt;b&gt;already escaped&lt;/b&gt;");
  });

  it("handles very long and unicode agent names without dropping the buttons", () => {
    const longName = "Ágent 🤖 ".repeat(60) + "مرحبا";
    setup([makeCard(1, { agentName: longName })]);
    expect(screen.getByText(new RegExp("Ágent 🤖"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("encodes the approval id in the decide URL so a hostile id cannot change the path", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup([makeCard(1, { id: "a/../../admin?x=1" })]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/approvals/a%2F..%2F..%2Fadmin%3Fx%3D1/decision");
  });
});
