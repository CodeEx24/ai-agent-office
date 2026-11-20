// AGO-150: agent cards with six states, a color-independent label, and a link (not a decision) for "Waiting on you".
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_OFFICE_STATES, type AgentOfficeState, type AgentOfficeStateName } from "@ago/shared";

import type { OfficeEventSource } from "../realtime/office-event-source";
import { AGENT_STATE_VIEWS, getAgentStateView } from "./agent-state-view";
import { AgentCard } from "./AgentCard";
import { AgentCardGrid, streamNotice } from "./AgentCardGrid";
import { AgentStateBadge } from "./AgentStateBadge";
import { APPROVALS_PATH, approvalHref, approvalLinkQuerySchema } from "./approval-link";

const AGENT = { id: "11111111-1111-4111-8111-111111111111", name: "Ada", role: "Researcher" };

function officeState(state: AgentOfficeStateName, extra: Partial<AgentOfficeState> = {}) {
  return {
    agent_id: AGENT.id,
    state,
    detail: null,
    run_id: null,
    approval_id: null,
    ...extra,
  } satisfies AgentOfficeState;
}

/** A source with an empty feed: the store goes live with no runs. */
function emptySource(): OfficeEventSource {
  return {
    fetchEvents: () => Promise.resolve([]),
    fetchRunEvents: () => Promise.resolve([]),
    subscribe: (_workspaceId, handlers) => {
      queueMicrotask(() => {
        handlers.onStatus("subscribed");
      });
      return () => undefined;
    },
  };
}

describe("state views", () => {
  it("covers exactly the six states with unique labels and unique shapes", () => {
    expect(Object.keys(AGENT_STATE_VIEWS).sort()).toEqual([...AGENT_OFFICE_STATES].sort());
    const labels = AGENT_OFFICE_STATES.map((s) => getAgentStateView(s).label);
    const shapes = AGENT_OFFICE_STATES.map((s) => getAgentStateView(s).shape);
    expect(new Set(labels).size).toBe(6);
    expect(new Set(shapes).size).toBe(6);
  });
});

describe("AgentStateBadge", () => {
  it.each(AGENT_OFFICE_STATES)("%s shows its text label and its own shape", (state) => {
    const { container } = render(<AgentStateBadge state={state} />);
    const view = getAgentStateView(state);
    const badge = screen.getByTestId("agent-state-badge");
    expect(within(badge).getByText(view.label)).toBeInTheDocument();
    expect(container.querySelector(`svg[data-shape="${view.shape}"]`)).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("waiting on you is the red (destructive) badge", () => {
    render(<AgentStateBadge state="waiting_on_you" />);
    expect(screen.getByTestId("agent-state-badge").className).toContain("bg-destructive");
  });

  it("no other state uses the red badge", () => {
    for (const state of AGENT_OFFICE_STATES.filter((s) => s !== "waiting_on_you")) {
      const { unmount } = render(<AgentStateBadge state={state} />);
      expect(screen.getByTestId("agent-state-badge").className).not.toContain("bg-destructive");
      unmount();
    }
  });
});

describe("AgentCard", () => {
  it("shows Idle when no run is known", () => {
    render(<AgentCard agent={AGENT} office={null} />);
    expect(screen.getByTestId("agent-card")).toHaveAttribute("data-state", "idle");
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("waiting on you links to the approval and only navigates", () => {
    render(
      <AgentCard agent={AGENT} office={officeState("waiting_on_you", { approval_id: "appr-1" })} />,
    );
    const link = screen.getByTestId("agent-approval-link");
    expect(link).toHaveAttribute("href", approvalHref("appr-1"));
    expect(link.getAttribute("href")).toContain(
      "/app/approvals?approval=appr-1#approval-appr-1-title",
    );
    expect(link).toHaveAccessibleName(/Waiting on you/);
    // Nothing on the card can approve or deny.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("waiting on you without an approval id falls back to the inbox", () => {
    render(<AgentCard agent={AGENT} office={officeState("waiting_on_you")} />);
    expect(screen.getByTestId("agent-approval-link")).toHaveAttribute("href", APPROVALS_PATH);
  });

  it("other states are not links", () => {
    render(<AgentCard agent={AGENT} office={officeState("working")} />);
    expect(screen.queryByTestId("agent-approval-link")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders agent-supplied text as plain text, never as markup", () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <AgentCard
        agent={{ ...AGENT, name: payload }}
        office={officeState("error_or_paused", { detail: payload })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(payload, { exact: false }).length).toBeGreaterThan(0);
  });

  it("shows a placeholder, not Idle, while the first events have not arrived", () => {
    render(<AgentCard agent={AGENT} office={null} isLoading />);
    expect(screen.getByTestId("agent-state-loading")).toBeInTheDocument();
    expect(screen.queryByText("Idle")).toBeNull();
  });
});

describe("approval link", () => {
  it("encodes the id in the query and the fragment", () => {
    expect(approvalHref("a b/c")).toBe(
      "/app/approvals?approval=a%20b%2Fc#approval-a%20b%2Fc-title",
    );
    expect(approvalHref(null)).toBe("/app/approvals");
  });

  it("the page query accepts one short id and rejects the rest", () => {
    expect(approvalLinkQuerySchema.safeParse({ approval: "x" }).success).toBe(true);
    expect(approvalLinkQuerySchema.safeParse({}).success).toBe(true);
    expect(approvalLinkQuerySchema.safeParse({ approval: "" }).success).toBe(false);
    expect(approvalLinkQuerySchema.safeParse({ approval: "x".repeat(129) }).success).toBe(false);
    expect(approvalLinkQuerySchema.safeParse({ approval: ["a", "b"] }).success).toBe(false);
  });
});

describe("stream notices", () => {
  it("says something for every status except live", () => {
    expect(streamNotice("live")).toBeNull();
    for (const status of [
      "idle",
      "connecting",
      "catching_up",
      "reconnecting",
      "stopped",
    ] as const) {
      expect(streamNotice(status)).toEqual(expect.any(String));
    }
    expect(streamNotice("stopped")).toMatch(/stopped/i);
    expect(streamNotice("reconnecting")).toMatch(/reconnecting/i);
  });
});

describe("AgentCardGrid", () => {
  it("shows an empty state when the workspace has no agents", () => {
    render(<AgentCardGrid workspaceId={AGENT.id} agents={[]} source={emptySource()} />);
    expect(screen.getByTestId("agent-cards-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-grid")).toBeNull();
  });

  it("shows every agent as Idle once the stream is live", async () => {
    render(
      <AgentCardGrid
        workspaceId="22222222-2222-4222-8222-222222222222"
        agents={[AGENT]}
        source={emptySource()}
      />,
    );
    expect(screen.getByTestId("office-stream-status")).toHaveAttribute("role", "status");
    await waitFor(() => {
      expect(screen.getByTestId("agent-card")).toHaveAttribute("data-state", "idle");
    });
    expect(screen.getByTestId("agent-state-badge")).toHaveTextContent("Idle");
  });
});
