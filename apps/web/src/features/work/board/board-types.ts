/**
 * Plain data the task board works with (AGO-146). Everything here is serializable (the server page hands it to the
 * client board) and read-only: the board never writes any of it.
 */

/** The six columns, left to right. */
export const BOARD_COLUMN_IDS = [
  "inbox",
  "assigned",
  "in_progress",
  "in_review",
  "waiting_on_you",
  "done",
] as const;
export type BoardColumnId = (typeof BOARD_COLUMN_IDS)[number];

export const BOARD_COLUMN_LABELS: Readonly<Record<BoardColumnId, string>> = {
  inbox: "Inbox",
  assigned: "Assigned",
  in_progress: "In progress",
  in_review: "In review",
  waiting_on_you: "Waiting on you",
  done: "Done",
};

/** A task row as the board reads it. `title` is untrusted text. */
export interface BoardTask {
  readonly id: string;
  readonly title: string;
  /** `tasks.status`: free text in the database; the board only looks for `done` and `in_review`. */
  readonly status: string;
  readonly agentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A run row: it ties a run id (all the office store knows) to its task. `status` is only a fallback. */
export interface BoardRun {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: string;
}

/** A pending approval row (not yet decided, not consumed, not expired when it was read). */
export interface BoardApproval {
  readonly id: string;
  readonly runId: string | null;
  readonly createdAt: string;
}

export interface BoardAgent {
  readonly id: string;
  readonly name: string;
}

/** Everything one read of the board brings back. */
export interface BoardData {
  readonly workspaceId: string;
  readonly tasks: readonly BoardTask[];
  readonly runs: readonly BoardRun[];
  readonly approvals: readonly BoardApproval[];
  readonly agents: readonly BoardAgent[];
}

/** Why a card is where it is, in words a person reads on the card. */
export type BoardCardReason =
  | "waiting_approval"
  | "paused"
  | "failed"
  | "running"
  | "run_completed"
  | "marked_review"
  | "queued"
  | "assigned"
  | "unassigned"
  | "done";

export interface BoardCard {
  readonly taskId: string;
  readonly title: string;
  readonly agentName: string | null;
  readonly column: BoardColumnId;
  readonly reason: BoardCardReason;
  /** Set when the card is blocked on a pending approval: the approval the card links to. */
  readonly approvalId: string | null;
  /** What orders the card inside its column (ISO instant). */
  readonly sortAt: string;
}

export type BoardColumns = Readonly<Record<BoardColumnId, readonly BoardCard[]>>;

export interface BoardView {
  readonly columns: BoardColumns;
  /** Done tasks beyond the shown cap. */
  readonly hiddenDone: number;
}
