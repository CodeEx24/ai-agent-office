"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { ApprovalCardData } from "./approval-card";
import { ApprovalCard, type CardDecisionState } from "./ApprovalCard";

/**
 * How often the inbox re-reads the server while it is open. It is the freshness bound for "decisions update the
 * run within 2 seconds" (AGO-37): a decision made elsewhere shows within one interval, and a decision made here
 * shows at once (the card reports the result, then the next read drops it). Kept at half the 2 s budget so a read
 * that takes a moment still lands inside it. Realtime would need the `approvals` table in the realtime
 * publication, which is a migration (a follow-up); polling needs none.
 */
export const INBOX_REFRESH_MS = 1_000;

type Decision = "approved" | "denied";

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

export function ApprovalInbox({
  workspaceId,
  cards,
  canDecide,
  serverNowMs,
}: {
  workspaceId: string;
  cards: readonly ApprovalCardData[];
  canDecide: boolean;
  /** The server's clock at render time, so the first client render shows the same ages (no hydration mismatch). */
  serverNowMs: number;
}) {
  const router = useRouter();
  const [nowMs, setNowMs] = useState(serverNowMs);
  const [states, setStates] = useState<Record<string, CardDecisionState>>({});

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setNowMs(Date.now());
      router.refresh();
    }, INBOX_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [router]);

  function decide(approvalId: string, decision: Decision) {
    setStates((current) => ({ ...current, [approvalId]: { kind: "sending" } }));
    void postDecision(workspaceId, approvalId, decision).then((result) => {
      setStates((current) => ({ ...current, [approvalId]: result }));
      // Read again now instead of waiting for the next tick: a decided card leaves the list.
      router.refresh();
    });
  }

  if (cards.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="approvals-empty">
        Nothing is waiting for you.
      </p>
    );
  }

  return (
    <div
      role="list"
      aria-label="Pending approvals"
      className="grid gap-4"
      data-testid="approvals-list"
    >
      {cards.map((card) => (
        <ApprovalCard
          key={card.id}
          card={card}
          nowMs={nowMs}
          canDecide={canDecide}
          state={states[card.id] ?? { kind: "idle" }}
          onDecide={decide}
        />
      ))}
    </div>
  );
}
