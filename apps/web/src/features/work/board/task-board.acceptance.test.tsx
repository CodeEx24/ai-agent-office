// AGO-146 acceptance tests, written from the ticket's acceptance criteria (not from the implementation tables):
//   AC1  Cards move with run state in realtime
//   AC2  Waiting on you lists blocked approvals first
//   AC3  Tests pass, no regressions, docs updated (this file plus the docs check at the bottom)
// The board runs through the real office store with a fake event source. No database, no model calls.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ago/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FetchRunEventsArgs,
  OfficeEventSource,
  SubscribeHandlers,
} from "../../office/realtime/office-event-source";
import { officeStore } from "../../office/store";
import type { BoardData } from "./board-types";
import { loadBoardData } from "./load-board-data";
import { BOARD_POLL_MS } from "./use-board-data";
import { TaskBoard } from "./TaskBoard";

const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xa1, 1);
const OTHER_WS = uuid(0xa1, 2);
const AGENT = uuid(0xa2, 1);
const HASH = "b".repeat(64);
const T0 = Date.parse("2026-11-20T09:00:00.000Z");

const task = (n: number, title: string, over: Partial<BoardData["tasks"][number]> = {}) => ({
  id: uuid(0xa3, n),
  title,
  status: "todo",
  agentId: AGENT as string | null,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...over,
});
const runRow = (n: number, taskN: number, status = "queued") => ({
  id: uuid(0xa4, n),
  taskId: uuid(0xa3, taskN),
  agentId: AGENT,
  status,
  createdAt: "2026-11-20T08:50:00.000Z",
});
const approvalRow = (n: number, runN: number, createdAt: string) => ({
  id: uuid(0xa5, n),
  runId: uuid(0xa4, runN),
  createdAt,
});

let counter = 0;
function ev(
  runN: number,
  seq: number,
  type: string,
  fields: Record<string, unknown>,
  workspace = WS,
) {
  counter += 1;
  return {
    id: uuid(0xa6, counter),
    workspace_id: workspace,
    run_id: uuid(0xa4, runN),
    agent_id: AGENT,
    seq,
    type,
    payload: { version: 1, ...fields },
    created_at: new Date(T0 + counter * 1000).toISOString(),
  };
}
const created = (runN: number, taskN: number, workspace = WS) =>
  ev(runN, 1, "run.created", { agent_id: AGENT, task_id: uuid(0xa3, taskN) }, workspace);
const started = (runN: number) => ev(runN, 2, "run.started", {});
const paused = (runN: number) =>
  ev(runN, 3, "run.paused", { requested_by: "human", reason: "user_pause" });
const toolCall = (runN: number, workspace = WS) =>
  ev(
    runN,
    3,
    "tool_call.requested",
    { call_id: "c1", tool_name: "send_email", tier: 3, input_hash: HASH },
    workspace,
  );
const approvalRequested = (runN: number, approvalN: number, workspace = WS) =>
  ev(
    runN,
    4,
    "approval.requested",
    {
      approval_id: uuid(0xa5, approvalN),
      call_id: "c1",
      payload_hash: HASH,
      tier: 3,
      expires_at: "2026-11-20T12:00:00.000Z",
    },
    workspace,
  );
const approvalDecided = (runN: number, approvalN: number) =>
  ev(runN, 5, "approval.decided", {
    approval_id: uuid(0xa5, approvalN),
    outcome: "approved",
    decided_by: "human",
    payload_hash: HASH,
  });

const data = (over: Partial<BoardData> = {}): BoardData => ({
  workspaceId: WS,
  tasks: [],
  runs: [],
  approvals: [],
  agents: [{ id: AGENT, name: "Ada" }],
  ...over,
});

class FakeSource implements OfficeEventSource {
  handlers: SubscribeHandlers | null = null;
  subscriptions = 0;
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
    return () => undefined;
  }
  insert(r: unknown, push = true) {
    this.stored.push(r);
    if (push) this.handlers?.onRow(r);
  }
}

const renderBoard = (
  source: FakeSource,
  initial: BoardData | null,
  load: () => Promise<BoardData> = () => Promise.resolve(initial ?? data()),
) => render(<TaskBoard workspaceId={WS} source={source} initial={initial} load={load} />);
const goLive = (source: FakeSource) =>
  act(async () => {
    source.handlers?.onStatus("subscribed");
    await Promise.resolve();
  });
const column = (id: string) => screen.getByTestId(`board-column-${id}`);
const titles = (id: string) =>
  within(column(id))
    .queryAllByTestId("board-card")
    .map((c) => document.getElementById(c.getAttribute("aria-labelledby") ?? "")?.textContent);
const hrefs = (id: string) =>
  within(column(id))
    .queryAllByTestId("board-card-approval-link")
    .map((a) => a.getAttribute("href"));
const inboxHref = (approvalN: number) => {
  const id = uuid(0xa5, approvalN);
  return `/app/approvals?approval=${id}#approval-${id}-title`;
};

afterEach(() => {
  act(() => {
    officeStore.getState().disconnect();
  });
});

describe("AC1: cards move with run state in realtime", () => {
  it("moves a card from Assigned to In progress to Waiting on you as run events arrive, without a reload", async () => {
    const source = new FakeSource([created(1, 1)]);
    renderBoard(source, data({ tasks: [task(1, "Draft the launch post")], runs: [runRow(1, 1)] }));
    await goLive(source);
    await waitFor(() => {
      expect(titles("assigned")).toEqual(["Draft the launch post"]);
    });

    await act(async () => {
      source.insert(started(1));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titles("in_progress")).toEqual(["Draft the launch post"]);
    });
    expect(titles("assigned")).toEqual([]);

    await act(async () => {
      source.insert(toolCall(1));
      source.insert(approvalRequested(1, 1));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titles("waiting_on_you")).toEqual(["Draft the launch post"]);
    });
    expect(titles("in_progress")).toEqual([]);
    expect(hrefs("waiting_on_you")).toEqual([inboxHref(1)]);
  });

  it("moves a running card to Waiting on you when its run is paused", async () => {
    const source = new FakeSource([created(1, 1), started(1)]);
    renderBoard(source, data({ tasks: [task(1, "Summarise the inbox")], runs: [runRow(1, 1)] }));
    await goLive(source);
    await waitFor(() => {
      expect(titles("in_progress")).toEqual(["Summarise the inbox"]);
    });
    await act(async () => {
      source.insert(paused(1));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titles("waiting_on_you")).toEqual(["Summarise the inbox"]);
    });
  });

  it("shows each task exactly once after a reconnect that replays old rows and brings missed ones", async () => {
    const source = new FakeSource([created(1, 1), started(1), created(2, 2), started(2)]);
    renderBoard(
      source,
      data({
        tasks: [task(1, "First task"), task(2, "Second task")],
        runs: [runRow(1, 1), runRow(2, 2)],
      }),
    );
    await goLive(source);
    await waitFor(() => {
      expect(titles("in_progress")).toHaveLength(2);
    });

    await act(async () => {
      source.handlers?.onStatus("closed");
      await Promise.resolve();
    });
    // While away, the first run asks for approval (stored, not pushed).
    source.insert(toolCall(1), false);
    source.insert(approvalRequested(1, 1), false);

    await waitFor(
      () => {
        expect(source.subscriptions).toBe(2);
      },
      { timeout: 4000 },
    );
    await goLive(source);
    // Rows the board already has arrive again.
    await act(async () => {
      source.handlers?.onRow(created(1, 1));
      source.handlers?.onRow(started(2));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(titles("waiting_on_you")).toEqual(["First task"]);
      },
      { timeout: 4000 },
    );
    expect(titles("in_progress")).toEqual(["Second task"]); // no gap: the other run is untouched
    expect(screen.getAllByTestId("board-card")).toHaveLength(2); // no duplicate
  }, 10_000);

  it("ignores events from another workspace even for a run id the board knows", async () => {
    const source = new FakeSource([created(1, 1), started(1)]);
    renderBoard(source, data({ tasks: [task(1, "Own task")], runs: [runRow(1, 1)] }));
    await goLive(source);
    await waitFor(() => {
      expect(titles("in_progress")).toEqual(["Own task"]);
    });

    await act(async () => {
      source.handlers?.onRow(toolCall(1, OTHER_WS));
      source.handlers?.onRow(approvalRequested(1, 9, OTHER_WS));
      source.handlers?.onRow(created(7, 1, OTHER_WS));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(titles("in_progress")).toEqual(["Own task"]);
    expect(titles("waiting_on_you")).toEqual([]);
    expect(screen.getAllByTestId("board-card")).toHaveLength(1);
  });

  it("shows a task the next poll brings in, without touching the run states from the stream", async () => {
    const source = new FakeSource([created(1, 1), started(1)]);
    vi.useFakeTimers();
    try {
      const first = data({ tasks: [task(1, "Old task")], runs: [runRow(1, 1)] });
      const second = data({
        tasks: [task(1, "Old task"), task(2, "New task", { agentId: null })],
        runs: [runRow(1, 1)],
      });
      renderBoard(source, first, () => Promise.resolve(second));
      await goLive(source);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOARD_POLL_MS);
      });
      expect(titles("inbox")).toEqual(["New task"]);
      expect(titles("in_progress")).toEqual(["Old task"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AC2: Waiting on you lists blocked approvals first", () => {
  it("lists several blocked tasks oldest approval first, each linking to its own approval, above a paused task", async () => {
    // Approval ages (hand-written): task 3 at 08:10, task 1 at 08:20, task 2 at 08:30. Events arrive in another order.
    const source = new FakeSource([
      created(4, 4),
      started(4),
      paused(4),
      created(2, 2),
      started(2),
      toolCall(2),
      approvalRequested(2, 2),
      created(1, 1),
      started(1),
      toolCall(1),
      approvalRequested(1, 1),
      created(3, 3),
      started(3),
      toolCall(3),
      approvalRequested(3, 3),
    ]);
    renderBoard(
      source,
      data({
        tasks: [
          task(1, "Task one"),
          task(2, "Task two"),
          task(3, "Task three"),
          task(4, "Paused task"),
        ],
        runs: [runRow(1, 1), runRow(2, 2), runRow(3, 3), runRow(4, 4)],
        approvals: [
          approvalRow(1, 1, "2026-11-20T08:20:00.000Z"),
          approvalRow(2, 2, "2026-11-20T08:30:00.000Z"),
          approvalRow(3, 3, "2026-11-20T08:10:00.000Z"),
        ],
      }),
    );
    await goLive(source);
    await waitFor(() => {
      expect(titles("waiting_on_you")).toHaveLength(4);
    });
    expect(titles("waiting_on_you")).toEqual(["Task three", "Task one", "Task two", "Paused task"]);
    expect(hrefs("waiting_on_you")).toEqual([inboxHref(3), inboxHref(1), inboxHref(2)]);
  });

  it("puts a blocked task above a paused task even when the paused one has waited longer", async () => {
    const source = new FakeSource([
      created(1, 1),
      started(1),
      paused(1),
      created(2, 2),
      started(2),
      toolCall(2),
      approvalRequested(2, 2),
    ]);
    renderBoard(
      source,
      data({
        tasks: [task(1, "Paused first"), task(2, "Blocked later")],
        runs: [runRow(1, 1), runRow(2, 2)],
        approvals: [approvalRow(2, 2, "2026-11-20T08:59:00.000Z")],
      }),
    );
    await goLive(source);
    await waitFor(() => {
      expect(titles("waiting_on_you")).toHaveLength(2);
    });
    expect(titles("waiting_on_you")).toEqual(["Blocked later", "Paused first"]);
  });

  it("drops a card out of Waiting on you at once when its approval is decided, before the next poll", async () => {
    const source = new FakeSource([
      created(1, 1),
      started(1),
      toolCall(1),
      approvalRequested(1, 1),
    ]);
    // The polled row stays "pending" (stale): the stream must win.
    renderBoard(
      source,
      data({
        tasks: [task(1, "Decide me")],
        runs: [runRow(1, 1)],
        approvals: [approvalRow(1, 1, "2026-11-20T08:20:00.000Z")],
      }),
    );
    await goLive(source);
    await waitFor(() => {
      expect(titles("waiting_on_you")).toEqual(["Decide me"]);
    });

    await act(async () => {
      source.insert(approvalDecided(1, 1));
      await Promise.resolve();
    });
    // No timers advanced and no reload: it is already gone.
    expect(titles("waiting_on_you")).toEqual([]);
    expect(titles("in_progress")).toEqual(["Decide me"]);
    expect(screen.queryAllByTestId("board-card-approval-link")).toHaveLength(0);
  });

  it("offers no approve, deny or other control on any card", async () => {
    const source = new FakeSource([
      created(1, 1),
      started(1),
      toolCall(1),
      approvalRequested(1, 1),
    ]);
    renderBoard(source, data({ tasks: [task(1, "Read only")], runs: [runRow(1, 1)] }));
    await goLive(source);
    await waitFor(() => {
      expect(titles("waiting_on_you")).toHaveLength(1);
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/approve\b|deny|reject/i)).toBeNull();
  });
});

describe("edge cases", () => {
  it("shows six empty columns in the ticket's order and a first-task message on an empty board", async () => {
    const source = new FakeSource();
    renderBoard(source, data());
    await goLive(source);
    await waitFor(() => {
      expect(screen.getByTestId("board-empty")).toBeTruthy();
    });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Inbox0 tasks",
      "Assigned0 tasks",
      "In progress0 tasks",
      "In review0 tasks",
      "Waiting on you0 tasks",
      "Done0 tasks",
    ]);
    expect(screen.getAllByTestId("board-column-empty")).toHaveLength(6);
    expect(screen.queryAllByTestId("board-card")).toHaveLength(0);
  });

  it("renders hostile task and agent text as plain text", async () => {
    const hostileTitle = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const hostileAgent = `<b onclick="x()">Mallory</b>`;
    const source = new FakeSource();
    const { container } = renderBoard(
      source,
      data({
        tasks: [task(1, hostileTitle)],
        agents: [{ id: AGENT, name: hostileAgent }],
      }),
    );
    await goLive(source);
    await waitFor(() => {
      expect(titles("assigned")).toEqual([hostileTitle]);
    });
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getByText(hostileAgent)).toBeTruthy();
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
  });

  describe("polling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      vi.useRealTimers();
    });
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    it("does not read while the tab is hidden and reads again when it is visible", async () => {
      const load = vi.fn(() => Promise.resolve(data()));
      const source = new FakeSource();
      renderBoard(source, data(), load);
      await goLive(source);
      act(() => {
        setHidden(true);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOARD_POLL_MS * 6);
      });
      expect(load).not.toHaveBeenCalled();

      act(() => {
        setHidden(false);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("keeps the last good board and says so when a read fails, then recovers", async () => {
      const good = data({ tasks: [task(1, "Still here")] });
      const load = vi
        .fn<() => Promise<BoardData>>()
        .mockRejectedValueOnce(new Error("db password leaked"))
        .mockResolvedValue(good);
      const source = new FakeSource();
      renderBoard(source, good, load);
      await goLive(source);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOARD_POLL_MS);
      });
      expect(screen.getByTestId("board-load-error").textContent).toMatch(/last list/);
      expect(screen.queryByText(/password/)).toBeNull();
      expect(titles("assigned")).toEqual(["Still here"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOARD_POLL_MS * 4);
      });
      expect(screen.queryByTestId("board-load-error")).toBeNull();
    });
  });
});

describe("loader scoping: another workspace's tasks are never shown", () => {
  const at = "2026-11-20T08:00:00Z";
  /** A fake database holding two workspaces; it answers only rows matching every `eq` filter it was given. */
  function twoWorkspaceClient() {
    const rows: Record<string, Record<string, unknown>[]> = {
      tasks: [
        {
          id: uuid(0xa3, 1),
          workspace_id: WS,
          title: "Mine",
          status: "todo",
          agent_id: null,
          created_at: at,
          updated_at: at,
        },
        {
          id: uuid(0xa3, 2),
          workspace_id: OTHER_WS,
          title: "Theirs",
          status: "todo",
          agent_id: null,
          created_at: at,
          updated_at: at,
        },
      ],
      runs: [
        {
          id: uuid(0xa4, 1),
          workspace_id: WS,
          task_id: uuid(0xa3, 1),
          agent_id: AGENT,
          status: "queued",
          created_at: at,
        },
        {
          id: uuid(0xa4, 2),
          workspace_id: OTHER_WS,
          task_id: uuid(0xa3, 2),
          agent_id: AGENT,
          status: "queued",
          created_at: at,
        },
      ],
      approvals: [
        {
          id: uuid(0xa5, 1),
          workspace_id: OTHER_WS,
          run_id: uuid(0xa4, 2),
          status: "pending",
          consumed_at: null,
          expires_at: "2999-01-01T00:00:00Z",
          created_at: at,
        },
      ],
      agents: [
        { id: AGENT, workspace_id: WS, name: "Ada" },
        { id: uuid(0xa2, 2), workspace_id: OTHER_WS, name: "Eve" },
      ],
    };
    const client = {
      from(table: string) {
        const eqs: [string, unknown][] = [];
        const builder: Record<string, unknown> = {};
        for (const name of ["select", "is", "not", "gt", "order", "limit"]) {
          builder[name] = () => builder;
        }
        builder.eq = (column: string, value: unknown) => {
          eqs.push([column, value]);
          return builder;
        };
        builder.then = (resolve: (v: unknown) => unknown) =>
          resolve({
            data: (rows[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v)),
            error: null,
          });
        return builder;
      },
    };
    return client as unknown as SupabaseClient<Database>;
  }

  it("returns only the asked workspace's tasks, runs, approvals and agents", async () => {
    const result = await loadBoardData(twoWorkspaceClient(), WS);
    expect(result.tasks.map((t) => t.title)).toEqual(["Mine"]);
    expect(result.runs.map((r) => r.id)).toEqual([uuid(0xa4, 1)]);
    expect(result.approvals).toEqual([]);
    expect(result.agents.map((a) => a.name)).toEqual(["Ada"]);
  });
});

describe("AC3: docs exist", () => {
  const repoRoot = join(__dirname, "../../../../../..");
  it("has a feature guide that names the six columns and the read-only rule", () => {
    const path = join(repoRoot, "docs/features/task-board.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    for (const name of [
      "Inbox",
      "Assigned",
      "In progress",
      "In review",
      "Waiting on you",
      "Done",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/read-only/i);
  });
});
