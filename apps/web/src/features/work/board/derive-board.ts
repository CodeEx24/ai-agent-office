import type { OfficeState, RunPhase, RunView } from "@ago/shared/office";

import {
  BOARD_COLUMN_IDS,
  type BoardCard,
  type BoardCardReason,
  type BoardColumnId,
  type BoardData,
  type BoardView,
} from "./board-types";

/** Done shows the newest tasks only; the rest is counted, not listed. */
export const MAX_DONE_CARDS = 25;

const LIVE_PHASES: readonly RunPhase[] = ["queued", "active", "paused"];

/** What the polled `runs.status` column says, for a run the office store has no events for. Unknown: ignored. */
function phaseFromRunStatus(status: string): RunPhase | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "completed":
    case "succeeded":
      return "completed";
    default:
      return null;
  }
}

interface RunSummary {
  readonly id: string;
  readonly phase: RunPhase;
  readonly at: string;
  /** The run has an open approval request (from the stream when it knows the run, else from a pending row). */
  readonly isBlocked: boolean;
  readonly approvalId: string | null;
  readonly approvalSince: string | null;
}

const isLive = (phase: RunPhase): boolean => LIVE_PHASES.includes(phase);
const byTimeAsc = (a: string, b: string): number => Date.parse(a) - Date.parse(b);

/**
 * Run state comes from the office store (`office`, the realtime stream): that is what moves a card. The polled rows
 * only tie runs to tasks and name the pending approvals' ages. A run the store has events for is judged by the
 * stream alone, so a decided approval leaves Waiting on you the moment `approval.decided` arrives, not at the next
 * poll. A run the store has no events for falls back to the polled `runs.status`.
 */
function summarizeRun(
  run: BoardData["runs"][number],
  view: RunView | undefined,
  approvalRows: ReadonlyMap<string, BoardData["approvals"][number]>,
): RunSummary | null {
  const row = approvalRows.get(run.id) ?? null;
  if (view !== undefined) {
    const phase = view.phase?.value ?? "queued";
    const open = view.approval;
    return {
      id: run.id,
      phase,
      at: view.last_event_at,
      isBlocked: open !== null && isLive(phase),
      approvalId: open === null ? null : (row?.id ?? open.approval_id),
      approvalSince: open === null ? null : (row?.createdAt ?? view.last_event_at),
    };
  }
  const phase = phaseFromRunStatus(run.status);
  if (phase === null) return null;
  return {
    id: run.id,
    phase,
    at: run.createdAt,
    isBlocked: row !== null && isLive(phase),
    approvalId: row?.id ?? null,
    approvalSince: row?.createdAt ?? null,
  };
}

/**
 * The board, derived on read (AGO-146). Pure: tasks, runs, pending approvals and the office state in, six
 * columns out. No schema, nothing stored. The first matching rule places a task:
 *
 * 1. Done: `tasks.status = 'done'`.
 * 2. Waiting on you, first group: a live run is blocked on an open approval (oldest request first).
 * 3. Waiting on you, second group: a live run is paused, or the latest run failed with nothing live (oldest first).
 * 4. In progress: a live run is active.
 * 5. In review (TEMPORARY, decision D1 in the ticket record, until a review status exists): the latest run
 *    completed and nothing is live, or `tasks.status = 'in_review'`.
 * 6. Assigned: an agent is set or a run is queued.
 * 7. Inbox: nothing assigned, nothing running.
 */
export function deriveBoard(data: BoardData, office: OfficeState | null): BoardView {
  const approvalRows = new Map(
    data.approvals.flatMap((a) => (a.runId === null ? [] : [[a.runId, a] as const])),
  );
  const agentNames = new Map(data.agents.map((a) => [a.id, a.name]));
  const runsByTask = new Map<string, BoardData["runs"][number][]>();
  for (const run of data.runs) {
    runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) ?? []), run]);
  }

  const cards: BoardCard[] = data.tasks.map((task) => {
    const summaries = (runsByTask.get(task.id) ?? []).flatMap((run) => {
      const summary = summarizeRun(run, office?.runs[run.id], approvalRows);
      return summary === null ? [] : [summary];
    });
    const live = summaries.filter((s) => isLive(s.phase));
    const active = live.filter((s) => s.phase === "active");
    const latest = [...summaries].sort((a, b) => byTimeAsc(b.at, a.at))[0] ?? null;
    const blocked = live
      .filter((s) => s.isBlocked)
      .sort((a, b) => byTimeAsc(a.approvalSince ?? a.at, b.approvalSince ?? b.at))[0];
    const paused = live
      .filter((s) => s.phase === "paused")
      .sort((a, b) => byTimeAsc(a.at, b.at))[0];

    let column: BoardColumnId;
    let reason: BoardCardReason;
    let approvalId: string | null = null;
    let sortAt = task.updatedAt;

    if (task.status === "done") {
      column = "done";
      reason = "done";
    } else if (blocked !== undefined) {
      column = "waiting_on_you";
      reason = "waiting_approval";
      approvalId = blocked.approvalId;
      sortAt = blocked.approvalSince ?? blocked.at;
    } else if (paused !== undefined) {
      column = "waiting_on_you";
      reason = "paused";
      sortAt = paused.at;
    } else if (live.length === 0 && latest?.phase === "failed") {
      column = "waiting_on_you";
      reason = "failed";
      sortAt = latest.at;
    } else if (active.length > 0) {
      column = "in_progress";
      reason = "running";
      sortAt = [...active].sort((a, b) => byTimeAsc(b.at, a.at))[0]?.at ?? sortAt;
    } else if (live.length === 0 && latest?.phase === "completed") {
      column = "in_review";
      reason = "run_completed";
      sortAt = latest.at;
    } else if (live.length === 0 && task.status === "in_review") {
      column = "in_review";
      reason = "marked_review";
    } else if (live.length > 0) {
      column = "assigned";
      reason = "queued";
      sortAt = live[0]?.at ?? sortAt;
    } else if (task.agentId !== null) {
      column = "assigned";
      reason = "assigned";
    } else {
      column = "inbox";
      reason = "unassigned";
    }

    return {
      taskId: task.id,
      title: task.title,
      agentName: task.agentId === null ? null : (agentNames.get(task.agentId) ?? null),
      column,
      reason,
      approvalId,
      sortAt,
    };
  });

  const columns = Object.fromEntries(
    BOARD_COLUMN_IDS.map((id) => [id, cards.filter((c) => c.column === id)]),
  ) as unknown as Record<BoardColumnId, BoardCard[]>;

  for (const id of BOARD_COLUMN_IDS) {
    if (id === "waiting_on_you") columns[id].sort(compareWaiting);
    else {
      columns[id].sort((a, b) => byTimeAsc(b.sortAt, a.sortAt) || a.taskId.localeCompare(b.taskId));
    }
  }
  const hiddenDone = Math.max(0, columns.done.length - MAX_DONE_CARDS);
  columns.done = columns.done.slice(0, MAX_DONE_CARDS);
  return { columns, hiddenDone };
}

/** Blocked on an approval first, then paused or failed; oldest wait first inside each group. */
function compareWaiting(a: BoardCard, b: BoardCard): number {
  const group = (c: BoardCard): number => (c.reason === "waiting_approval" ? 0 : 1);
  return group(a) - group(b) || byTimeAsc(a.sortAt, b.sortAt) || a.taskId.localeCompare(b.taskId);
}

/** Run ids the office store knows that no loaded run row maps to a task: a refetch may find their tasks. */
export function findUnmappedRunIds(data: BoardData, office: OfficeState | null): string[] {
  if (office === null) return [];
  const known = new Set(data.runs.map((r) => r.id));
  return Object.keys(office.runs).filter((id) => !known.has(id));
}
