// AGO-150 acceptance tests (functional tester, round 2). Extends agent-cards.test.tsx: here the grid is driven
// through the real office store by a fake event source, so each card state comes from events, not from props.
// Expected labels and hrefs are written out by hand from the ticket, not read from the view table.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_OFFICE_STATES } from "@ago/shared";

import type { OfficeEventSource, SubscribeHandlers } from "../realtime/office-event-source";
import { officeStore } from "../store";
import { AgentCard } from "./AgentCard";
import { AgentCardGrid } from "./AgentCardGrid";

const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xd1, 1);
const AGENT_WAIT = { id: uuid(0xd2, 1), name: "Ada", role: "Researcher" };
const AGENT_NO_RUN = { id: uuid(0xd2, 2), name: "Bo", role: "Writer" };
const RUN = uuid(0xd3, 1);
const HASH = "a".repeat(64);
const T0 = Date.parse("2026-11-20T09:00:00.000Z");

let rowCounter = 0;
function row(seq: number, type: string, fields: Record<string, unknown>) {
  rowCounter += 1;
  return {
    id: uuid(0xd4, rowCounter),
    workspace_id: WS,
    run_id: RUN,
    agent_id: AGENT_WAIT.id,
    seq,
    type,
    payload: { version: 1, ...fields },
    created_at: new Date(T0 + rowCounter * 1000).toISOString(),
  };
}

/** A source whose stored feed and live stream the test controls. */
class ControlledSource implements OfficeEventSource {
  handlers: SubscribeHandlers | null = null;
  constructor(readonly stored: readonly unknown[] = []) {}
  fetchEvents() {
    return Promise.resolve(this.stored);
  }
  fetchRunEvents() {
    return Promise.resolve([]);
  }
  subscribe(_workspaceId: string, handlers: SubscribeHandlers) {
    this.handlers = handlers;
    return () => undefined;
  }
}

const waitingLog = () => [
  row(1, "run.created", { agent_id: AGENT_WAIT.id, task_id: null }),
  row(2, "run.started", {}),
  row(3, "tool_call.requested", {
    call_id: "c1",
    tool_name: "send_email",
    tier: 3,
    input_hash: HASH,
  }),
  row(4, "approval.requested", {
    approval_id: "appr-42",
    call_id: "c1",
    payload_hash: HASH,
    tier: 3,
    expires_at: "2026-11-20T10:00:00.000Z",
  }),
];

afterEach(() => {
  act(() => {
    officeStore.getState().disconnect();
  });
});

describe("AC1: each state has a distinct label and shape, independent of color", () => {
  it("six cards side by side show six different visible labels and six different shapes", () => {
    const { container } = render(
      <div>
        {AGENT_OFFICE_STATES.map((state, i) => (
          <AgentCard
            key={state}
            agent={{ id: `a${String(i)}`, name: `Agent ${String(i)}`, role: "r" }}
            office={{
              agent_id: `a${String(i)}`,
              state,
              detail: null,
              run_id: null,
              approval_id: null,
            }}
          />
        ))}
      </div>,
    );
    const labels = screen.getAllByTestId("agent-state-badge").map((b) => b.textContent);
    expect(labels).toEqual([
      "Idle",
      "Working",
      "Thinking",
      "Collaborating",
      "Waiting on you",
      "Error or paused",
    ]);
    const shapes = [...container.querySelectorAll("svg")].map((s) => s.getAttribute("data-shape"));
    expect(new Set(shapes).size).toBe(6);
  });

  it("stripped of every class, each badge is still told apart by its text and its shape", () => {
    render(
      <div>
        {AGENT_OFFICE_STATES.map((state) => (
          <AgentCard
            key={state}
            agent={{ id: state, name: state, role: "r" }}
            office={{ agent_id: state, state, detail: null, run_id: null, approval_id: null }}
          />
        ))}
      </div>,
    );
    for (const badge of screen.getAllByTestId("agent-state-badge")) {
      badge.removeAttribute("class");
      expect(badge.textContent.trim()).not.toBe("");
      expect(badge.querySelector("svg[data-shape]")).not.toBeNull();
    }
  });

  it("the decorative shape is hidden from assistive technology so the label is read once", () => {
    const { container } = render(
      <AgentCard
        agent={AGENT_WAIT}
        office={{
          agent_id: AGENT_WAIT.id,
          state: "working",
          detail: null,
          run_id: null,
          approval_id: null,
        }}
      />,
    );
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("AC2: waiting on you is red, labelled and opens the approval without deciding", () => {
  it("an agent that asked for approval shows the red Waiting on you badge linking to that approval", async () => {
    const source = new ControlledSource(waitingLog());
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT, AGENT_NO_RUN]} source={source} />);
    act(() => {
      source.handlers?.onStatus("subscribed");
    });
    const link = await screen.findByTestId("agent-approval-link");
    expect(link).toHaveAttribute("href", "/app/approvals?approval=appr-42#approval-appr-42-title");
    expect(link).toHaveAccessibleName(
      "Agent state: Waiting on you. Open the approval request for Ada.",
    );
    expect(within(link).getByTestId("agent-state-badge").className).toContain("bg-destructive");
    // The agent with no run is Idle and has no link.
    const cards = screen.getAllByTestId("agent-card");
    expect(cards.map((c) => c.getAttribute("data-state"))).toEqual(["waiting_on_you", "idle"]);
    expect(screen.getAllByTestId("agent-approval-link")).toHaveLength(1);
  });

  it("opening the link makes no decision request and the card offers no button", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const source = new ControlledSource(waitingLog());
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT]} source={source} />);
    act(() => {
      source.handlers?.onStatus("subscribed");
    });
    const link = await screen.findByTestId("agent-approval-link");
    const before = fetchSpy.mock.calls.length;
    fireEvent.click(link);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/^(approve|deny|reject)$/i)).toBeNull();
    expect(fetchSpy.mock.calls.length).toBe(before);
    fetchSpy.mockRestore();
  });

  it("the card goes back to Idle and drops the link once the approval is decided", async () => {
    const source = new ControlledSource(waitingLog());
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT]} source={source} />);
    act(() => {
      source.handlers?.onStatus("subscribed");
    });
    await screen.findByTestId("agent-approval-link");
    act(() => {
      source.handlers?.onRow(
        row(5, "approval.decided", {
          approval_id: "appr-42",
          outcome: "denied",
          decided_by: "human",
          payload_hash: HASH,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("agent-approval-link")).toBeNull();
    });
    expect(screen.getByTestId("agent-card")).not.toHaveAttribute("data-state", "waiting_on_you");
  });

  it("a waiting card with an id that needs encoding still links inside the approvals page", () => {
    render(
      <AgentCard
        agent={AGENT_WAIT}
        office={{
          agent_id: AGENT_WAIT.id,
          state: "waiting_on_you",
          detail: null,
          run_id: null,
          approval_id: "x/../../y?z=1#w",
        }}
      />,
    );
    const href = screen.getByTestId("agent-approval-link").getAttribute("href") ?? "";
    expect(href.startsWith("/app/approvals?approval=")).toBe(true);
    expect(href).not.toContain("../");
    expect(href.split("#")).toHaveLength(2);
  });
});

describe("stream states in the grid", () => {
  it("shows loading placeholders, not Idle, before the stream connects", () => {
    const source = new ControlledSource();
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT]} source={source} />);
    expect(screen.getByTestId("office-stream-status")).toHaveTextContent(/connecting/i);
    expect(screen.getByTestId("agent-state-loading")).toBeInTheDocument();
    expect(screen.queryByText("Idle")).toBeNull();
  });

  it("tells the person the states may be out of date when the stream drops, and keeps the cards", async () => {
    const source = new ControlledSource(waitingLog());
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT]} source={source} />);
    act(() => {
      source.handlers?.onStatus("subscribed");
    });
    await screen.findByTestId("agent-approval-link");
    act(() => {
      source.handlers?.onStatus("error");
    });
    await waitFor(() => {
      expect(screen.getByTestId("office-stream-status")).toHaveAttribute(
        "data-status",
        "reconnecting",
      );
    });
    expect(screen.getByTestId("office-stream-status")).toHaveTextContent(/out of date/i);
    expect(screen.getByTestId("agent-approval-link")).toBeInTheDocument();
  });

  it("tells the person live updates have stopped, with the way to recover", async () => {
    const source = new ControlledSource();
    render(<AgentCardGrid workspaceId={WS} agents={[AGENT_WAIT]} source={source} />);
    act(() => {
      officeStore.getState().disconnect();
    });
    await waitFor(() => {
      expect(screen.getByTestId("office-stream-status")).toHaveAttribute("data-status", "stopped");
    });
    expect(screen.getByTestId("office-stream-status")).toHaveTextContent(/stopped.*reload/i);
    expect(screen.getByTestId("office-stream-status")).toHaveAttribute("role", "status");
  });

  it("the empty workspace still reports the stream status next to the empty message", () => {
    render(<AgentCardGrid workspaceId={WS} agents={[]} source={new ControlledSource()} />);
    expect(screen.getByTestId("agent-cards-empty")).toHaveTextContent(/no agents yet/i);
    expect(screen.getByTestId("office-stream-status")).toBeInTheDocument();
  });
});

describe("agent text is plain text", () => {
  it("renders markup-like and markdown-like role and name as literal text", () => {
    const hostile = '<b>bold</b> [x](javascript:alert(1)) <a href="https://evil.test">go</a>';
    const { container } = render(
      <AgentCard
        agent={{ id: "a1", name: hostile, role: hostile }}
        office={{
          agent_id: "a1",
          state: "error_or_paused",
          detail: hostile,
          run_id: null,
          approval_id: null,
        }}
      />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByTestId("agent-state-detail")).toHaveTextContent(hostile);
  });

  it("keeps a very long unbroken detail and unicode text in the card", () => {
    const longText = "x".repeat(5000);
    render(
      <AgentCard
        agent={{ id: "a1", name: "Zoë 🤖 مرحبا", role: "r" }}
        office={{
          agent_id: "a1",
          state: "error_or_paused",
          detail: longText,
          run_id: null,
          approval_id: null,
        }}
      />,
    );
    expect(screen.getByText("Zoë 🤖 مرحبا")).toBeInTheDocument();
    expect(screen.getByTestId("agent-state-detail")).toHaveTextContent(longText);
  });
});
