import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import type { ApprovalCardData } from "./approval-card";
import {
  ApprovalInbox,
  DECISION_LOCK_MS,
  INBOX_REFRESH_MS,
  MAX_BACKOFF_MS,
  REFRESH_TIMEOUT_MS,
  nextBackoffMs,
} from "./ApprovalInbox";

const WORKSPACE = "37000000-0000-4000-8000-0000000000f1";
const APPROVAL = "37000000-0000-4000-8000-0000000000c1";
const NOW = Date.parse("2026-11-14T10:05:00.000Z");

const card: ApprovalCardData = {
  id: APPROVAL,
  agentId: "37000000-0000-4000-8000-0000000000b1",
  agentName: "Scout",
  runId: "37000000-0000-4000-8000-0000000000a1",
  action: "email.send",
  payloadHash: "ab".repeat(32),
  tier: 3,
  reason: "tier_3_needs_human",
  createdAt: "2026-11-14T10:00:00.000Z",
  expiresAt: "2026-11-14T11:00:00.000Z",
  recentSteps: [
    { seq: 4, label: "Approval requested" },
    { seq: 2, label: "Requested email.send (tier 3)" },
  ],
  cost: { inputTokens: 1500, outputTokens: 300, costMicros: 17_345 },
};

const fetchMock = vi.fn();

beforeEach(() => {
  refresh.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides: { cards?: ApprovalCardData[]; canDecide?: boolean } = {}) {
  return render(
    <ApprovalInbox
      workspaceId={WORKSPACE}
      cards={overrides.cards ?? [card]}
      canDecide={overrides.canDecide ?? true}
      serverNowMs={NOW}
    />,
  );
}

describe("ApprovalInbox card", () => {
  it("shows the agent, age, reason, payload fingerprint, recent steps and cost", () => {
    setup();
    expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    expect(screen.getByText(/Scout wants to run email\.send/)).toBeInTheDocument();
    expect(screen.getByTestId("approval-age")).toHaveTextContent("Waiting 5 min");
    expect(screen.getByTestId("approval-time-left")).toHaveTextContent("55 min left");
    expect(screen.getByTestId("approval-reason")).toHaveTextContent("tier_3_needs_human");
    expect(screen.getByTestId("approval-payload")).toHaveTextContent("abababababab");
    expect(screen.getByTestId("approval-payload")).toHaveTextContent("not stored yet");
    expect(screen.getByTestId("approval-cost")).toHaveTextContent("$0.02");
    expect(screen.getByTestId("approval-cost")).toHaveTextContent("1,800 tokens");
    expect(screen.getByTestId("approval-steps").children).toHaveLength(2);
  });

  it("says so when nothing is waiting", () => {
    setup({ cards: [] });
    expect(screen.getByTestId("approvals-empty")).toHaveTextContent("Nothing is waiting");
  });

  it("renders hostile agent text as inert text, never as HTML", () => {
    const hostile = {
      ...card,
      agentName: '<img src=x onerror="alert(1)">',
      action: "<script>alert(2)</script>",
      reason: '<a href="javascript:alert(3)">x</a>',
      recentSteps: [{ seq: 1, label: "<b>bold</b>" }],
    };
    const { container } = setup({ cards: [hostile] });
    expect(container.querySelector("img, script, a, b")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(container).toHaveTextContent("<script>alert(2)</script>");
  });

  it("shows no decide buttons to someone who cannot decide", () => {
    setup({ canDecide: false });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-view-only")).toHaveTextContent("view-only access");
    expect(screen.queryByText(/Only members can decide/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-details-note")).not.toBeInTheDocument();
  });

  it("says plainly, next to Approve, that the call details are not shown, and keeps the hash small", () => {
    setup();
    const note = screen.getByTestId("approval-details-note");
    expect(note).toHaveTextContent("You can't see what this call will send or change");
    expect(note.compareDocumentPosition(screen.getByRole("button", { name: "Approve" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId("approval-payload")).toHaveTextContent("Not shown yet");
    expect(screen.getByText("abababababab…")).toHaveAttribute("title", "ab".repeat(32));
  });

  it("shows Edit and Ask disabled with a reason, and they do nothing", () => {
    setup();
    for (const name of ["Edit", "Ask"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("Not available yet"));
      fireEvent.click(button);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApprovalInbox decisions", () => {
  it("approves through the one human-only decide route with exactly workspace and decision", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-result")).toHaveTextContent("Approved"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/approvals/${APPROVAL}/decision`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: WORKSPACE,
      decision: "approved",
    });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("rejects with the decision `denied`", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(screen.getByTestId("approval-result")).toHaveTextContent("Rejected"),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: WORKSPACE,
      decision: "denied",
    });
  });

  it("explains a request that can no longer be decided, and lets the list refresh", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("can no longer be decided");
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("explains a refusal and a network failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not allowed");

    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server"),
    );
  });

  it("only ever calls the decide route", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    for (const [url] of fetchMock.mock.calls as [string][]) {
      expect(url).toMatch(/^\/api\/approvals\/[0-9a-f-]{36}\/decision$/);
    }
  });
});

describe("ApprovalInbox freshness (decisions show within 2 seconds)", () => {
  function page(serverNowMs: number, loadFailed = false) {
    return (
      <ApprovalInbox
        workspaceId={WORKSPACE}
        cards={[card]}
        canDecide
        serverNowMs={serverNowMs}
        loadFailed={loadFailed}
      />
    );
  }

  it("re-reads the server at least twice inside the 2 second budget when each read comes back", () => {
    expect(INBOX_REFRESH_MS * 2).toBeLessThanOrEqual(2_000);
    vi.useFakeTimers();
    const { rerender } = render(page(NOW));
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(page(NOW + 1));
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never queues a second read behind one that has not come back (in-flight guard)", () => {
    vi.useFakeTimers();
    render(page(NOW));
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("approvals-refresh-failed")).not.toBeInTheDocument();
  });

  it("shows an inline 'couldn't refresh, retrying' line when a read never returns, keeps the list, and retries with backoff", () => {
    vi.useFakeTimers();
    render(page(NOW));
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS + REFRESH_TIMEOUT_MS + INBOX_REFRESH_MS);
    });
    expect(screen.getByTestId("approvals-refresh-failed")).toHaveTextContent("retrying");
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    const callsAtTimeout = refresh.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(MAX_BACKOFF_MS * 2);
    });
    expect(refresh.mock.calls.length).toBeGreaterThan(callsAtTimeout);
  });

  it("when the server says it could not read, keeps the last good list, says so, and waits longer each time", () => {
    vi.useFakeTimers();
    const { rerender } = render(page(NOW));
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(
      <ApprovalInbox
        workspaceId={WORKSPACE}
        cards={[]}
        canDecide={false}
        serverNowMs={NOW + 1}
        loadFailed
      />,
    );
    expect(screen.getByTestId("approvals-refresh-failed")).toHaveTextContent("retrying");
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByTestId("approvals-empty")).not.toBeInTheDocument();
    // After one failure the wait is longer than the normal interval.
    act(() => {
      vi.advanceTimersByTime(INBOX_REFRESH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(nextBackoffMs(1));
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(nextBackoffMs(1)).toBeGreaterThan(INBOX_REFRESH_MS);
    expect(nextBackoffMs(50)).toBe(MAX_BACKOFF_MS);
  });

  it("does not say 'nothing is waiting' when the very first read failed", () => {
    render(
      <ApprovalInbox
        workspaceId={WORKSPACE}
        cards={[]}
        canDecide={false}
        serverNowMs={NOW}
        loadFailed
      />,
    );
    expect(screen.getByTestId("approvals-refresh-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("approvals-empty")).not.toBeInTheDocument();
  });

  it("shows the result of a decision made here with no wait for the next read", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setup();
    const startedAt = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("approval-result")).toHaveTextContent("Approved");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("ApprovalInbox after a decision (the next card must never land under the cursor)", () => {
  const second: ApprovalCardData = {
    ...card,
    id: "37000000-0000-4000-8000-0000000000c2",
    agentName: "Writer",
    createdAt: "2026-11-14T10:01:00.000Z",
  };

  function twoCards(serverNowMs = NOW, cards: ApprovalCardData[] = [card, second]) {
    return (
      <ApprovalInbox workspaceId={WORKSPACE} cards={cards} canDecide serverNowMs={serverNowMs} />
    );
  }

  it("a quick second click right after a decision cannot decide another card", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { rerender } = render(twoCards());
    fireEvent.click(
      within(screen.getAllByTestId("approval-card")[0]!).getByRole("button", { name: "Approve" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The server now lists only the second card: it would move up under the cursor.
    rerender(twoCards(NOW + 1, [second]));
    const cards = screen.getAllByTestId("approval-card");
    expect(cards).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: /^(Approve|Reject)$/ })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the decided card in place as a receipt, then lets the next card be decided once the hold ends", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { rerender } = render(twoCards());
    fireEvent.click(
      within(screen.getAllByTestId("approval-card")[0]!).getByRole("button", { name: "Approve" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender(twoCards(NOW + 1, [second]));
    const [receipt, next] = screen.getAllByTestId("approval-card");
    expect(within(receipt!).getByTestId("approval-result")).toHaveTextContent("Approved");
    expect(within(receipt!).getByText(/Scout wants to run/)).toBeInTheDocument();
    expect(within(next!).getByText(/Writer wants to run/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DECISION_LOCK_MS);
    });
    expect(within(next!).getByRole("button", { name: "Approve" })).toBeEnabled();
    // The receipt itself never offers a second decision.
    expect(within(receipt!).getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(within(receipt!).getByRole("button", { name: "Dismiss" }));
    expect(screen.getAllByTestId("approval-card")).toHaveLength(1);
  });

  it("disables every decide button on every card while a decision is in flight", async () => {
    let finish: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    render(twoCards());
    fireEvent.click(
      within(screen.getAllByTestId("approval-card")[0]!).getByRole("button", { name: "Approve" }),
    );
    for (const button of screen.getAllByRole("button", { name: /^(Approve|Reject)$/ })) {
      expect(button).toBeDisabled();
    }
    await act(async () => {
      finish(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
  });
});
