"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApprovalCardData } from "./approval-card";
import { ApprovalCard, type CardDecisionState } from "./ApprovalCard";

/**
 * How often the inbox re-reads the server while it is open. It is the freshness bound for "decisions update the
 * run within 2 seconds" (AGO-37): a decision made elsewhere shows within one interval, and a decision made here
 * shows at once (the card reports the result, and stays in place as a receipt). Kept at half the 2 s budget so a
 * read that takes a moment still lands inside it. Realtime would need the `approvals` table in the realtime
 * publication, which is a migration (a follow-up); polling needs none.
 */
export const INBOX_REFRESH_MS = 1_000;
/** A read that has not produced a new page after this long counts as failed (the next one waits, with backoff). */
export const REFRESH_TIMEOUT_MS = 3_000;
/** The longest wait between reads while reads keep failing. */
export const MAX_BACKOFF_MS = 15_000;
/**
 * After a decision, every decide button stays disabled this long. The list re-reads and may move the next card
 * under the cursor; a quick second click must never decide a request the person has not read.
 */
export const DECISION_LOCK_MS = 1_500;

type Decision = "approved" | "denied";

/** The wait before the next read after `failures` failed reads in a row: doubles each time, up to the cap. */
export function nextBackoffMs(failures: number): number {
  return Math.min(INBOX_REFRESH_MS * 2 ** failures, MAX_BACKOFF_MS);
}

/** The one place the inbox decides: the human-only route from AGO-58. There is no other path. */
async function postDecision(
  workspaceId: string,
  approvalId: string,
  decision: Decision,
): Promise<CardDecisionState> {
  let response: Response;
  try {
    response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, decision }),
    });
  } catch {
    return { kind: "failed", message: "Could not reach the server. Try again." };
  }
  if (response.ok) return { kind: "decided", decision };
  if (response.status === 404) {
    return {
      kind: "failed",
      message: "This request can no longer be decided: it was decided already, or it expired.",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "failed", message: "You are not allowed to decide this request." };
  }
  return { kind: "failed", message: "Could not record the decision. Try again." };
}

interface Snapshot {
  readonly serverNowMs: number;
  readonly cards: readonly ApprovalCardData[];
  readonly canDecide: boolean;
  /** False until one read has worked: the inbox cannot say "nothing is waiting" before it knows. */
  readonly hasData: boolean;
}

export function ApprovalInbox({
  workspaceId,
  cards,
  canDecide,
  serverNowMs,
  loadFailed = false,
}: {
  workspaceId: string;
  cards: readonly ApprovalCardData[];
  canDecide: boolean;
  /** The server's clock at render time, so the first client render shows the same ages (no hydration mismatch). */
  serverNowMs: number;
  /** True when the server could not read the list this time: keep showing the last good list and retry. */
  loadFailed?: boolean;
}) {
  const router = useRouter();
  const [nowMs, setNowMs] = useState(serverNowMs);
  const [states, setStates] = useState<Record<string, CardDecisionState>>({});
  /** Decided cards stay on screen as receipts (until dismissed), so the list below never jumps. */
  const [receipts, setReceipts] = useState<
    Record<string, { card: ApprovalCardData; index: number }>
  >({});
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [hasDecisionInFlight, setHasDecisionInFlight] = useState(false);
  const [timedOutFor, setTimedOutFor] = useState<number | null>(null);

  // The last good page. A failed read keeps it on screen instead of replacing it with nothing.
  const [snapshot, setSnapshot] = useState<Snapshot>({
    serverNowMs,
    cards,
    canDecide,
    hasData: !loadFailed,
  });
  if (snapshot.serverNowMs !== serverNowMs && !loadFailed) {
    setSnapshot({ serverNowMs, cards, canDecide, hasData: true });
  }

  const awaitingSinceMs = useRef<number | null>(null);
  const failureCount = useRef(0);
  const retryAtMs = useRef(0);
  const latestServerNowMs = useRef(serverNowMs);
  const isDeciding = useRef(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new page arrived: the read is no longer in flight; it worked, or the server said it could not read.
  useEffect(() => {
    latestServerNowMs.current = serverNowMs;
    awaitingSinceMs.current = null;
    if (loadFailed) {
      failureCount.current += 1;
      retryAtMs.current = Date.now() + nextBackoffMs(failureCount.current);
    } else {
      failureCount.current = 0;
      retryAtMs.current = 0;
    }
  }, [serverNowMs, loadFailed]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      setNowMs(now);
      if (awaitingSinceMs.current !== null) {
        // In-flight guard: never queue a second read behind one that has not come back.
        if (now - awaitingSinceMs.current < REFRESH_TIMEOUT_MS) return;
        awaitingSinceMs.current = null;
        failureCount.current += 1;
        retryAtMs.current = now + nextBackoffMs(failureCount.current);
        setTimedOutFor(latestServerNowMs.current);
        return;
      }
      if (now < retryAtMs.current) return;
      awaitingSinceMs.current = now;
      router.refresh();
    }, INBOX_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [router]);

  useEffect(
    () => () => {
      if (lockTimer.current !== null) clearTimeout(lockTimer.current);
    },
    [],
  );

  // Server order is kept. A receipt the server no longer lists goes back at the place it had, so nothing moves.
  const serverIds = new Set(snapshot.cards.map((card) => card.id));
  const displayed: ApprovalCardData[] = [...snapshot.cards];
  Object.values(receipts)
    .filter((receipt) => !serverIds.has(receipt.card.id))
    .sort((a, b) => a.index - b.index)
    .forEach((receipt) => {
      displayed.splice(Math.min(receipt.index, displayed.length), 0, receipt.card);
    });
  const isLocked = hasDecisionInFlight || isCoolingDown;
  const isRefreshFailing = loadFailed || timedOutFor === serverNowMs;

  function decide(approvalId: string, decision: Decision) {
    if (isDeciding.current || isCoolingDown) return;
    const index = displayed.findIndex((candidate) => candidate.id === approvalId);
    const card = displayed[index];
    if (!card) return;
    isDeciding.current = true;
    setHasDecisionInFlight(true);
    setStates((current) => ({ ...current, [approvalId]: { kind: "sending" } }));
    void postDecision(workspaceId, approvalId, decision).then((result) => {
      isDeciding.current = false;
      setHasDecisionInFlight(false);
      setStates((current) => ({ ...current, [approvalId]: result }));
      if (result.kind === "decided") {
        // Keep the card where it is as a receipt, and hold every decide button while the list re-reads.
        setReceipts((current) => ({ ...current, [approvalId]: { card, index } }));
        setIsCoolingDown(true);
        if (lockTimer.current !== null) clearTimeout(lockTimer.current);
        lockTimer.current = setTimeout(() => {
          setIsCoolingDown(false);
        }, DECISION_LOCK_MS);
      }
      // Read again now instead of waiting for the next tick.
      awaitingSinceMs.current = Date.now();
      router.refresh();
    });
  }

  function dismiss(approvalId: string) {
    setReceipts(({ [approvalId]: _gone, ...rest }) => rest);
    setStates(({ [approvalId]: _gone, ...rest }) => rest);
  }

  return (
    <div className="grid gap-4">
      {isRefreshFailing ? (
        <p
          role="status"
          className="text-sm text-destructive"
          data-testid="approvals-refresh-failed"
        >
          Couldn&apos;t refresh the list, retrying…
          {snapshot.hasData ? " What you see may be out of date." : ""}
        </p>
      ) : null}
      {displayed.length === 0 ? (
        snapshot.hasData ? (
          <p className="text-muted-foreground" data-testid="approvals-empty">
            Nothing is waiting for you.
          </p>
        ) : null
      ) : (
        <div
          role="list"
          aria-label="Pending approvals"
          className="grid gap-4"
          data-testid="approvals-list"
        >
          {displayed.map((card) => (
            <ApprovalCard
              key={card.id}
              card={card}
              nowMs={nowMs}
              canDecide={snapshot.canDecide}
              isLocked={isLocked}
              state={states[card.id] ?? { kind: "idle" }}
              onDecide={decide}
              onDismiss={dismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}
