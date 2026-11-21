import { describe, expect, it } from "vitest";
import {
  createOfficeState,
  type OfficeState,
  type RunPhase,
  type RunView,
} from "@ago/shared/office";

import type { BoardApproval, BoardData, BoardRun, BoardTask } from "./board-types";
import { deriveBoard, findUnmappedRunIds, MAX_DONE_CARDS } from "./derive-board";

const uuid = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = uuid(0xe1, 1);
const AGENT = uuid(0xe2, 1);
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 20, 9, minute)).toISOString();

const task = (n: number, over: Partial<BoardTask> = {}): BoardTask => ({
  id: uuid(0xe3, n),
  title: `Task ${String(n)}`,
  status: "todo",
  agentId: null,
  createdAt: at(0),
  updatedAt: at(n),
  ...over,
});
const run = (n: number, taskN: number, over: Partial<BoardRun> = {}): BoardRun => ({
  id: uuid(0xe4, n),
  taskId: uuid(0xe3, taskN),
  agentId: AGENT,
  status: "queued",
  createdAt: at(n),
  ...over,
});
const approval = (n: number, runN: number, minute: number): BoardApproval => ({
  id: uuid(0xe5, n),
  runId: uuid(0xe4, runN),
  createdAt: at(minute),
});

function view(runN: number, phase: RunPhase, minute: number, withApproval = false): RunView {
  return {
    run_id: uuid(0xe4, runN),
    agent_id: AGENT,
    last_seq: 3,
    last_event_at: at(minute),
    partial: false,
    phase: { value: phase, detail: null },
    tool: null,
    approval: withApproval
      ? { approval_id: uuid(0xe5, runN), call_id: "c1", tier: 3, expires_at: at(500) }
      : null,
    handoff: null,
    step: 1,
    error: null,
    message: null,
  };
}
const officeOf = (...views: RunView[]): OfficeState => ({
  ...createOfficeState(WS),
  runs: Object.fromEntries(views.map((v) => [v.run_id, v])),
});
const data = (over: Partial<BoardData>): BoardData => ({
  workspaceId: WS,
  tasks: [],
  runs: [],
  approvals: [],
  agents: [{ id: AGENT, name: "Ada" }],
  ...over,
});
const ids = (cards: readonly { taskId: string }[]): string[] => cards.map((c) => c.taskId);

describe("column placement (AC: the six columns)", () => {
  it("puts an unassigned task with no run in Inbox", () => {
    const { columns } = deriveBoard(data({ tasks: [task(1)] }), null);
    expect(ids(columns.inbox)).toEqual([uuid(0xe3, 1)]);
  });

  it("puts an assigned task with no run, or a queued run, in Assigned", () => {
    const { columns } = deriveBoard(
      data({
        tasks: [task(1, { agentId: AGENT }), task(2)],
        runs: [run(2, 2)],
      }),
      officeOf(view(2, "queued", 5)),
    );
    expect(ids(columns.assigned).sort()).toEqual([uuid(0xe3, 1), uuid(0xe3, 2)].sort());
    expect(columns.assigned.find((c) => c.taskId === uuid(0xe3, 1))?.agentName).toBe("Ada");
  });

  it("puts a task with an active run in In progress", () => {
    const { columns } = deriveBoard(
      data({ tasks: [task(1, { agentId: AGENT })], runs: [run(1, 1)] }),
      officeOf(view(1, "active", 5)),
    );
    expect(ids(columns.in_progress)).toEqual([uuid(0xe3, 1)]);
    expect(columns.assigned).toEqual([]);
  });

  it("puts a task whose latest run completed in In review (decision D1)", () => {
    const { columns } = deriveBoard(
      data({ tasks: [task(1, { agentId: AGENT })], runs: [run(1, 1)] }),
      officeOf(view(1, "completed", 5)),
    );
    expect(columns.in_review.map((c) => c.reason)).toEqual(["run_completed"]);
  });

  it("puts a task with status in_review in In review, and a new queued run takes it back to Assigned", () => {
    const t = task(1, { status: "in_review", agentId: AGENT });
    expect(ids(deriveBoard(data({ tasks: [t] }), null).columns.in_review)).toEqual([t.id]);
    const again = deriveBoard(
      data({ tasks: [t], runs: [run(1, 1)] }),
      officeOf(view(1, "queued", 5)),
    );
    expect(ids(again.columns.assigned)).toEqual([t.id]);
  });

  it("puts a done task in Done, whatever its runs say", () => {
    const { columns } = deriveBoard(
      data({ tasks: [task(1, { status: "done" })], runs: [run(1, 1)] }),
      officeOf(view(1, "active", 5)),
    );
    expect(ids(columns.done)).toEqual([uuid(0xe3, 1)]);
    expect(columns.in_progress).toEqual([]);
  });

  it("puts paused runs and failed runs in Waiting on you; a stopped run goes back to Assigned", () => {
    const { columns } = deriveBoard(
      data({
        tasks: [
          task(1, { agentId: AGENT }),
          task(2, { agentId: AGENT }),
          task(3, { agentId: AGENT }),
        ],
        runs: [run(1, 1), run(2, 2), run(3, 3)],
      }),
      officeOf(view(1, "paused", 5), view(2, "failed", 6), view(3, "stopped", 7)),
    );
    expect(columns.waiting_on_you.map((c) => c.reason).sort()).toEqual(["failed", "paused"]);
    expect(ids(columns.assigned)).toEqual([uuid(0xe3, 3)]);
  });
});

describe("AC2: Waiting on you lists blocked approvals first", () => {
  it("sorts blocked approvals first, oldest first, then paused and failed items, oldest first", () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => task(n, { agentId: AGENT }));
    const { columns } = deriveBoard(
      data({
        tasks,
        runs: [run(1, 1), run(2, 2), run(3, 3), run(4, 4), run(5, 5)],
        approvals: [approval(3, 3, 30), approval(5, 5, 10)],
      }),
      officeOf(
        view(1, "paused", 1), // oldest of all, but not an approval
        view(2, "failed", 2),
        view(3, "active", 31, true), // approval requested at minute 30
        view(4, "paused", 4),
        view(5, "active", 11, true), // approval requested at minute 10
      ),
    );
    expect(ids(columns.waiting_on_you)).toEqual([
      uuid(0xe3, 5), // approval from minute 10
      uuid(0xe3, 3), // approval from minute 30
      uuid(0xe3, 1), // paused, minute 1
      uuid(0xe3, 2), // failed, minute 2
      uuid(0xe3, 4), // paused, minute 4
    ]);
    expect(columns.waiting_on_you.slice(0, 2).map((c) => c.approvalId)).toEqual([
      uuid(0xe5, 5),
      uuid(0xe5, 3),
    ]);
    expect(columns.waiting_on_you.slice(2).every((c) => c.approvalId === null)).toBe(true);
  });

  it("takes a decided approval out at once: the stream says it is closed even if the polled row is stale", () => {
    const { columns } = deriveBoard(
      data({
        tasks: [task(1, { agentId: AGENT })],
        runs: [run(1, 1)],
        approvals: [approval(1, 1, 10)], // stale row, not yet re-read
      }),
      officeOf(view(1, "active", 12, false)),
    );
    expect(columns.waiting_on_you).toEqual([]);
    expect(ids(columns.in_progress)).toEqual([uuid(0xe3, 1)]);
  });

  it("uses the pending row for a run the stream has no events for yet", () => {
    const { columns } = deriveBoard(
      data({
        tasks: [task(1, { agentId: AGENT })],
        runs: [run(1, 1, { status: "running" })],
        approvals: [approval(1, 1, 10)],
      }),
      officeOf(),
    );
    expect(columns.waiting_on_you.map((c) => c.reason)).toEqual(["waiting_approval"]);
  });

  it("ignores a pending row for a run the stream says has ended", () => {
    const { columns } = deriveBoard(
      data({
        tasks: [task(1, { agentId: AGENT })],
        runs: [run(1, 1)],
        approvals: [approval(1, 1, 10)],
      }),
      officeOf(view(1, "stopped", 12)),
    );
    expect(columns.waiting_on_you).toEqual([]);
  });
});

describe("other rules", () => {
  it("orders other columns newest activity first", () => {
    const { columns } = deriveBoard(
      data({ tasks: [task(1, { updatedAt: at(1) }), task(2, { updatedAt: at(9) })] }),
      null,
    );
    expect(ids(columns.inbox)).toEqual([uuid(0xe3, 2), uuid(0xe3, 1)]);
  });

  it("caps Done and counts the rest", () => {
    const many = Array.from({ length: MAX_DONE_CARDS + 3 }, (_, i) =>
      task(i + 1, { status: "done" }),
    );
    const view_ = deriveBoard(data({ tasks: many }), null);
    expect(view_.columns.done).toHaveLength(MAX_DONE_CARDS);
    expect(view_.hiddenDone).toBe(3);
  });

  it("ignores a run row with an unknown status and no stream events", () => {
    const { columns } = deriveBoard(
      data({ tasks: [task(1)], runs: [run(1, 1, { status: "wat" })] }),
      null,
    );
    expect(ids(columns.inbox)).toEqual([uuid(0xe3, 1)]);
  });

  it("places every task exactly once, and keeps hostile text as plain data", () => {
    const hostile = task(1, { title: "<img src=x onerror=alert(1)>" });
    const out = deriveBoard(data({ tasks: [hostile, task(2), task(3, { status: "done" })] }), null);
    const all = Object.values(out.columns).flat();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((c) => c.taskId)).size).toBe(3);
    expect(all.find((c) => c.taskId === hostile.id)?.title).toBe("<img src=x onerror=alert(1)>");
  });

  it("finds stream runs that no loaded run row maps", () => {
    const d = data({ tasks: [task(1)], runs: [run(1, 1)] });
    expect(findUnmappedRunIds(d, officeOf(view(1, "active", 1), view(9, "active", 2)))).toEqual([
      uuid(0xe4, 9),
    ]);
    expect(findUnmappedRunIds(d, null)).toEqual([]);
  });
});
