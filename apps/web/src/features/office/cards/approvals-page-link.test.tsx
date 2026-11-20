// AGO-150: the approvals page tells the person when a card's request is no longer pending, and never decides.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => {
  const value: Record<string, unknown> = {};
  return { value };
});

vi.mock("../../auth/current-user", () => ({
  getCurrentUser: () => Promise.resolve({ id: "u1", email: "a@example.com" }),
}));
vi.mock("../../workspaces/workspace-access", () => ({
  getActiveWorkspace: () => Promise.resolve({ id: "w1", name: "W", role: "owner" }),
}));
vi.mock("../../approvals/inbox-data", () => ({
  loadApprovalInbox: () => Promise.resolve(inbox.value),
}));
vi.mock("../../approvals/ApprovalInbox", () => ({
  ApprovalInbox: () => <div data-testid="inbox-stub" />,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import ApprovalsPage from "../../../app/app/approvals/page";

async function renderPage(query: Record<string, string | string[] | undefined>) {
  render(await ApprovalsPage({ searchParams: Promise.resolve(query) }));
}

describe("approvals page opened from an agent card", () => {
  beforeEach(() => {
    inbox.value = {
      workspaceId: "w1",
      cards: [{ id: "pending-1" }],
      canDecide: true,
      generatedAtMs: 0,
    };
  });

  it("shows no cue when the request is still pending", async () => {
    await renderPage({ approval: "pending-1" });
    expect(screen.queryByTestId("approval-link-not-pending")).toBeNull();
    expect(screen.getByTestId("inbox-stub")).toBeInTheDocument();
  });

  it("shows a 'no longer pending' cue and still renders the inbox when it is gone", async () => {
    await renderPage({ approval: "decided-or-unknown" });
    expect(screen.getByTestId("approval-link-not-pending")).toHaveTextContent(/no longer pending/i);
    expect(screen.getByTestId("inbox-stub")).toBeInTheDocument();
  });

  it("the cue offers no way to decide, and an empty inbox still shows the cue", async () => {
    inbox.value = { workspaceId: "w1", cards: [], canDecide: true, generatedAtMs: 0 };
    await renderPage({ approval: "decided-1" });
    const cue = screen.getByTestId("approval-link-not-pending");
    expect(cue.querySelector("button, a, input")).toBeNull();
    expect(cue).toHaveAttribute("role", "status");
  });

  it("shows no cue without the query, or with an invalid one", async () => {
    await renderPage({});
    expect(screen.queryByTestId("approval-link-not-pending")).toBeNull();
    await renderPage({ approval: ["a", "b"] });
    expect(screen.queryAllByTestId("approval-link-not-pending")).toHaveLength(0);
  });

  it("shows no cue when the inbox failed to load (it cannot say the request is gone)", async () => {
    inbox.value = { loadFailed: true, workspaceId: "w1", generatedAtMs: 0 };
    await renderPage({ approval: "x" });
    expect(screen.queryByTestId("approval-link-not-pending")).toBeNull();
  });
});
