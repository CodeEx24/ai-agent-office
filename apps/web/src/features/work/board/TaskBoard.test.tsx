// AGO-146: the board is driven through the real office store by a fake event source, so every column comes from
// events (run state) plus the polled rows, never from props alone.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "../../office/realtime/office-event-source";
import { officeStore } from "../../office/store";
import type { BoardData } from "./board-types";
import { TaskBoard } from "./TaskBoard";

const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xf1, 1);
const AGENT = uuid(0xf2, 1);
const TASK_A = uuid(0xf3, 1);
const TASK_B = uuid(0xf3, 2);
const RUN_A = uuid(0xf4, 1);
const APPROVAL = uuid(0xf5, 1);
const HASH = "a".repeat(64);
const T0 = Date.parse("2026-11-20T09:00:00.000Z");

let counter = 0;
function row(runId: string, seq: number, type: string, fields: Record<string, unknown>) {
  counter += 1;
  return {
    id: uuid(0xf6, counter),
    workspace_id: WS,
    run_id: runId,
    agent_id: AGENT,
    seq,
    type,
    payload: { version: 1, ...fields },
    created_at: new Date(T0 + counter * 1000).toISOString(),
  };
}
const created = (seq = 1) => row(RUN_A, seq, "run.created", { agent_id: AGENT, task_id: TASK_A });
const started = (seq = 2) => row(RUN_A, seq, "run.started", {});
const toolCall = (seq = 3) =>
  row(RUN_A, seq, "tool_call.requested", {
    call_id: "c1",
    tool_name: "send_email",
    tier: 3,
    input_hash: HASH,
  });
const approvalRequested = (seq = 4) =>
  row(RUN_A, seq, "approval.requested", {
    approval_id: APPROVAL,
    call_id: "c1",
    payload_hash: HASH,
    tier: 3,
    expires_at: "2026-11-20T10:00:00.000Z",
  });
const approvalDecided = (seq = 5) =>
  row(RUN_A, seq, "approval.decided", {
    approval_id: APPROVAL,
    outcome: "approved",
    decided_by: "human",
    payload_hash: HASH,
  });
const completed = (seq = 6) => row(RUN_A, seq, "run.completed", { steps: 2 });

const boardData = (over: Partial<BoardData> = {}): BoardData => ({
  workspaceId: WS,
  tasks: [
    {
      id: TASK_A,
      title: "Write the welcome note",
      status: "todo",
      agentId: AGENT,
      createdAt: "2026-11-20T08:00:00.000Z",
      updatedAt: "2026-11-20T08:00:00.000Z",
    },
    {
      id: TASK_B,
      title: "Tidy the vault",
      status: "todo",
      agentId: null,
      createdAt: "2026-11-20T08:00:00.000Z",
      updatedAt: "2026-11-20T08:30:00.000Z",
    },
  ],
  runs: [
    {
      id: RUN_A,
      taskId: TASK_A,
      agentId: AGENT,
      status: "queued",
      createdAt: "2026-11-20T08:50:00.000Z",
    },
  ],
  approvals: [],
  agents: [{ id: AGENT, name: "Ada" }],
  ...over,
});

class ControlledSource implements OfficeEventSource {
  handlers: SubscribeHandlers | null = null;
  subscriptions = 0;
  closed = 0;
  stored: unknown[];
  constructor(stored: unknown[] = []) {
    this.stored = stored;
  }
  fetchEvents() {
    return Promise.resolve([...this.stored]);
  }
  fetchRunEvents({ runId, afterSeq }: FetchRunEventsArgs) {
    return Promise.resolve(
      this.stored.filter((r) => {
        const e = r as { run_id: string; seq: number };
        return e.run_id === runId && e.seq > afterSeq;
      }),
    );
  }
  subscribe(_workspaceId: string, handlers: SubscribeHandlers) {
    this.handlers = handlers;
    this.subscriptions += 1;
    return () => {
      this.closed += 1;
    };
  }
  /** A row stored and (by default) pushed live. */
  insert(r: unknown, push = true) {
    this.stored.push(r);
    if (push) this.handlers?.onRow(r);
  }
}

const noLoad = () => Promise.resolve(boardData());
const renderBoard = (
  source: ControlledSource,
  over: { initial?: BoardData | null; load?: () => Promise<BoardData> } = {},
) =>
  render(
    <TaskBoard
      workspaceId={WS}
      source={source}
      initial={over.initial === undefined ? boardData() : over.initial}
      load={over.load ?? noLoad}
    />,
  );
const goLive = async (source: ControlledSource) => {
  await act(async () => {
    source.handlers?.onStatus("subscribed");
    await Promise.resolve();
  });
};
const column = (id: string) => screen.getByTestId(`board-column-${id}`);
const cardTitles = (id: string) =>
  within(column(id))
    .queryAllByTestId("board-card")
    .map((c) => document.getElementById(c.getAttribute("aria-labelledby") ?? "")?.textContent);

afterEach(() => {
  act(() => {
    officeStore.getState().disconnect();
  });
});

describe("AC1: cards move with run state in realtime", () => {
  it("moves a card as events arrive, with no reload", async () => {
    const source = new ControlledSource([created(), started()]);
    renderBoard(source);
    await goLive(source);

    await waitFor(() => {
      expect(cardTitles("in_progress")).toEqual(["Write the welcome note"]);
    });
    expect(cardTitles("inbox")).toEqual(["Tidy the vault"]);

    // A live approval request arrives: the card moves to Waiting on you and links to the approval.
    await act(async () => {
      source.insert(toolCall());
      source.insert(approvalRequested());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(cardTitles("waiting_on_you")).toEqual(["Write the welcome note"]);
    });
    const link = within(column("waiting_on_you")).getByTestId("board-card-approval-link");
    expect(link.getAttribute("href")).toBe(
      `/app/approvals?approval=${APPROVAL}#approval-${APPROVAL}-title`,
    );
    expect(cardTitles("in_progress")).toEqual([]);

    // A person decides in the inbox, the run finishes: the same card ends in In review.
    await act(async () => {
      source.insert(approvalDecided());
      source.insert(completed());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(cardTitles("in_review")).toEqual(["Write the welcome note"]);
    });
    expect(cardTitles("waiting_on_you")).toEqual([]);
    expect(screen.getAllByTestId("board-card")).toHaveLength(2); // still one card per task
  });

  it("after a dropped connection it catches up with no duplicate card and no gap", async () => {
    const source = new ControlledSource([created(), started()]);
    renderBoard(source);
    await goLive(source);
    await waitFor(() => {
      expect(cardTitles("in_progress")).toHaveLength(1);
    });

    // The connection drops; the run moves on while the board is not listening.
    await act(async () => {
      source.handlers?.onStatus("closed");
      await Promise.resolve();
    });
    expect(screen.getByTestId("board-stream-status").getAttribute("data-status")).toBe(
      "reconnecting",
    );
    expect(screen.getByTestId("board-stream-status").textContent).toMatch(/Reconnecting/);
    source.insert(toolCall(), false);
    source.insert(approvalRequested(), false);

    await waitFor(
      () => {
        expect(source.subscriptions).toBe(2);
      },
      { timeout: 4000 },
    );
    await goLive(source);
    // A duplicate of an old row is pushed again after the reconnect: it changes nothing.
    await act(async () => {
      source.handlers?.onRow(started());
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(cardTitles("waiting_on_you")).toEqual(["Write the welcome note"]);
      },
      {
        timeout: 4000,
      },
    );
    expect(screen.getAllByTestId("board-card")).toHaveLength(2);
    expect(cardTitles("in_progress")).toEqual([]);
  }, 10_000);

  it("holds a row that is ahead of its run and fills the gap by seq", async () => {
    const source = new ControlledSource([created(), started()]);
    renderBoard(source);
    await goLive(source);
    await waitFor(() => {
      expect(cardTitles("in_progress")).toHaveLength(1);
    });
    // seq 3 and 4 are stored but only seq 5 is pushed live.
    const ahead = approvalDecided(5);
    source.stored.push(toolCall(3), approvalRequested(4), ahead);
    await act(async () => {
      source.handlers?.onRow(ahead);
      await Promise.resolve();
      await Promise.resolve();
    });
    // The approval was requested and then decided in the filled gap: the run is back in progress, not blocked.
    await waitFor(() => {
      expect(cardTitles("in_progress")).toEqual(["Write the welcome note"]);
    });
    expect(cardTitles("waiting_on_you")).toEqual([]);
  });
});

describe("AC2: Waiting on you lists blocked approvals first", () => {
  it("lists the task blocked on an approval above a paused one", async () => {
    const TASK_C = uuid(0xf3, 3);
    const RUN_C = uuid(0xf4, 3);
    const source = new ControlledSource([
      row(RUN_C, 1, "run.created", { agent_id: AGENT, task_id: TASK_C }),
      row(RUN_C, 2, "run.started", {}),
      row(RUN_C, 3, "run.paused", { requested_by: "human", reason: "user_pause" }),
      created(),
      started(),
      toolCall(),
      approvalRequested(),
    ]);
    const data = boardData({
      tasks: [
        ...boardData().tasks,
        {
          id: TASK_C,
          title: "Paused task",
          status: "todo",
          agentId: AGENT,
          createdAt: "2026-11-20T08:00:00.000Z",
          updatedAt: "2026-11-20T08:00:00.000Z",
        },
      ],
      runs: [
        ...boardData().runs,
        {
          id: RUN_C,
          taskId: TASK_C,
          agentId: AGENT,
          status: "paused",
          createdAt: "2026-11-20T08:00:00.000Z",
        },
      ],
    });
    renderBoard(source, { initial: data });
    await goLive(source);
    await waitFor(() => {
      expect(cardTitles("waiting_on_you")).toHaveLength(2);
    });
    // The paused run is older in the feed, but the blocked approval is listed first.
    expect(cardTitles("waiting_on_you")).toEqual(["Write the welcome note", "Paused task"]);
  });
});

describe("states and safety", () => {
  it("shows loading until the stream is up, then the empty column messages", async () => {
    const source = new ControlledSource();
    renderBoard(source);
    expect(screen.getAllByTestId("board-column-loading")).toHaveLength(6);
    await goLive(source);
    await waitFor(() => {
      expect(screen.queryAllByTestId("board-column-loading")).toHaveLength(0);
    });
    expect(within(column("done")).getByTestId("board-column-empty").textContent).toBe(
      "Nothing done yet.",
    );
  });

  it("shows an empty-workspace message when there are no tasks", async () => {
    const source = new ControlledSource();
    renderBoard(source, { initial: boardData({ tasks: [], runs: [] }) });
    await goLive(source);
    await waitFor(() => {
      expect(screen.getByTestId("board-empty")).toBeTruthy();
    });
  });

  it("says so when the first read fails and the server gave nothing, and retries", async () => {
    const source = new ControlledSource();
    renderBoard(source, { initial: null, load: () => Promise.reject(new Error("db down")) });
    await goLive(source);
    await waitFor(() => {
      expect(screen.getByTestId("board-load-error").textContent).toMatch(/Couldn't load/);
    });
    expect(screen.queryByText("db down")).toBeNull();
  });

  it("renders agent and task text as plain text, and has no approve or deny control", async () => {
    const base = boardData();
    const data = {
      ...base,
      tasks: base.tasks.map((t, i) =>
        i === 0 ? { ...t, title: "<img src=x onerror=alert(1)>" } : t,
      ),
    };
    const source = new ControlledSource([created(), started(), toolCall(), approvalRequested()]);
    const { container } = renderBoard(source, { initial: data });
    await goLive(source);
    await waitFor(() => {
      expect(cardTitles("waiting_on_you")).toHaveLength(1);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/approve\b|deny|reject/i)).toBeNull();
  });
});
