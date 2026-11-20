"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@ago/ui";

import { approvalHref } from "../../office/cards/approval-link";
import { streamNotice } from "../../office/cards/AgentCardGrid";
import type { OfficeEventSource } from "../../office/realtime/office-event-source";
import { useOfficeConnection, useOfficeStore } from "../../office/store";
import {
  BOARD_COLUMN_IDS,
  BOARD_COLUMN_LABELS,
  type BoardCard,
  type BoardCardReason,
  type BoardColumnId,
  type BoardData,
} from "./board-types";
import { deriveBoard } from "./derive-board";
import { useBoardData } from "./use-board-data";

const REASON_LABELS: Readonly<Record<BoardCardReason, string>> = {
  waiting_approval: "Waiting for your approval",
  paused: "Paused",
  failed: "Run failed",
  running: "Running",
  run_completed: "Run finished, ready for review",
  marked_review: "Marked for review",
  queued: "Queued",
  assigned: "Assigned, not started",
  unassigned: "Not assigned yet",
  done: "Done",
};

const EMPTY_LABELS: Readonly<Record<BoardColumnId, string>> = {
  inbox: "No new tasks.",
  assigned: "Nothing waiting to start.",
  in_progress: "Nothing running.",
  in_review: "Nothing to review.",
  waiting_on_you: "Nothing is waiting on you.",
  done: "Nothing done yet.",
};

/**
 * One task card (AGO-146). Every string (title, agent name) can trace back to agent or user text and is rendered as
 * React text, never as markup. A card blocked on an approval links to the approvals inbox; it only navigates.
 * Approving and denying stay in the inbox (the human-only route): the board has no such button.
 */
export function BoardTaskCard({ card }: { card: BoardCard }) {
  const titleId = `board-card-${card.taskId}-title`;
  return (
    <Card
      role="listitem"
      aria-labelledby={titleId}
      data-testid="board-card"
      data-task-id={card.taskId}
      data-reason={card.reason}
      className="min-w-0 gap-2 py-3 [&_*]:[overflow-wrap:anywhere]"
    >
      <CardHeader className="gap-0.5 px-4">
        <CardTitle id={titleId} className="text-sm font-medium">
          {card.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-4 text-xs text-muted-foreground">
        <p data-testid="board-card-reason">{REASON_LABELS[card.reason]}</p>
        <p>{card.agentName ?? "No agent"}</p>
        {card.reason === "waiting_approval" ? (
          <Link
            href={approvalHref(card.approvalId)}
            data-testid="board-card-approval-link"
            className="font-medium text-primary underline underline-offset-4"
          >
            Open the approval
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The task board (AGO-146): six columns of task cards. Column placement is `deriveBoard` over the run states in the
 * office store (the realtime stream, so cards move without a reload) and the polled tasks, runs and pending
 * approvals. `source` and `load` must be stable (create them once). Read-only.
 */
export function TaskBoard({
  workspaceId,
  source,
  initial,
  load,
}: {
  workspaceId: string;
  source: OfficeEventSource;
  initial: BoardData | null;
  load: () => Promise<BoardData>;
}) {
  useOfficeConnection(workspaceId, source);
  const office = useOfficeStore((s) => s.office);
  const status = useOfficeStore((s) => s.status);

  const officeRunKey = useMemo(
    () =>
      Object.keys(office?.runs ?? {})
        .sort()
        .join(","),
    [office],
  );
  const { data, hasError } = useBoardData({ initial, load, officeRunKey });

  const view = useMemo(() => (data === null ? null : deriveBoard(data, office)), [data, office]);
  const isLoading = view === null || status === "idle" || status === "connecting";
  const notice = streamNotice(status);
  const total =
    view === null ? 0 : BOARD_COLUMN_IDS.reduce((n, id) => n + view.columns[id].length, 0);

  return (
    <div className="grid gap-4">
      {/* Always mounted so a change of connection state is announced. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="board-stream-status"
        data-status={status}
        className={notice === null ? "sr-only" : "text-sm text-muted-foreground"}
      >
        {notice ?? "Live updates are on."}
      </p>
      {hasError ? (
        <p role="alert" data-testid="board-load-error" className="text-sm text-destructive">
          {data === null
            ? "Couldn't load the tasks. Retrying…"
            : "Couldn't refresh the tasks. Showing the last list, retrying…"}
        </p>
      ) : null}
      {!isLoading && total === 0 ? (
        <p className="text-muted-foreground" data-testid="board-empty">
          No tasks yet. Submit a goal and the Manager will plan tasks that show up here.
        </p>
      ) : null}
      <div
        data-testid="board"
        className="grid gap-4 md:flex md:snap-x md:items-start md:overflow-x-auto md:pb-2"
      >
        {BOARD_COLUMN_IDS.map((id) => {
          const cards = view?.columns[id] ?? [];
          const headingId = `board-column-${id}-title`;
          return (
            <section
              key={id}
              aria-labelledby={headingId}
              data-testid={`board-column-${id}`}
              className="grid min-w-0 content-start gap-2 rounded-lg border bg-muted/30 p-3 md:w-72 md:shrink-0 md:snap-start"
            >
              <h2
                id={headingId}
                className="flex items-center justify-between text-sm font-semibold"
              >
                {BOARD_COLUMN_LABELS[id]}
                <span
                  className="text-xs font-normal text-muted-foreground"
                  data-testid="board-column-count"
                >
                  {isLoading ? "" : cards.length}
                </span>
              </h2>
              {isLoading ? (
                <p className="text-sm text-muted-foreground" data-testid="board-column-loading">
                  Loading…
                </p>
              ) : cards.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="board-column-empty">
                  {EMPTY_LABELS[id]}
                </p>
              ) : (
                <div role="list" aria-label={BOARD_COLUMN_LABELS[id]} className="grid gap-2">
                  {cards.map((card) => (
                    <BoardTaskCard key={card.taskId} card={card} />
                  ))}
                </div>
              )}
              {id === "done" && view !== null && view.hiddenDone > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="board-done-hidden">
                  and {view.hiddenDone} older
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
