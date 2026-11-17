import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ago/ui";
import { useEffect, useRef } from "react";

import type { ApprovalCardData } from "./approval-card";
import { formatAge, formatCostMicros, formatTimeLeft } from "./approval-format";

export type CardDecisionState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "decided"; readonly decision: "approved" | "denied" }
  | { readonly kind: "failed"; readonly message: string };

const NOT_YET_AVAILABLE = "Not available yet: a follow-up ticket adds this.";

/**
 * One pending approval (AGO-37). Presentational: it gets its data and a decide callback. EVERY field is rendered
 * as React text, never as HTML, because the strings can trace back to agent output (untrusted). Approve and
 * Reject call `onDecide`, which posts to the one human-only decide route (AGO-58). Edit and Ask have no backend
 * yet, so they are shown disabled with a reason and do nothing.
 */
export function ApprovalCard({
  card,
  nowMs,
  canDecide,
  isLocked,
  state,
  onDecide,
  onDismiss,
}: {
  card: ApprovalCardData;
  nowMs: number;
  canDecide: boolean;
  /** True while ANY card is being decided or the list is settling after a decision: no decide button may fire. */
  isLocked: boolean;
  state: CardDecisionState;
  onDecide: (id: string, decision: "approved" | "denied") => void;
  onDismiss: (id: string) => void;
}) {
  const isBusy = state.kind === "sending" || state.kind === "decided" || isLocked;
  const titleId = `approval-${card.id}-title`;
  const dismissRef = useRef<HTMLButtonElement>(null);

  // Approve or Reject unmounts with the decision (it is disabled, so focus would fall to the page body). Focus moves
  // to this card's Dismiss control, which is the receipt's one action, so the next Tab stays in the card.
  useEffect(() => {
    if (state.kind === "decided") dismissRef.current?.focus();
  }, [state.kind]);

  return (
    <Card
      role="listitem"
      aria-labelledby={titleId}
      data-testid="approval-card"
      className="min-w-0 [&_dd]:[overflow-wrap:anywhere]"
    >
      <CardHeader>
        <CardTitle id={titleId} className="text-base [overflow-wrap:anywhere]">
          {card.agentName} wants to run {card.action}
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">
          <span data-testid="approval-age">Waiting {formatAge(card.createdAt, nowMs)}</span>
          {" · "}
          <span data-testid="approval-time-left">{formatTimeLeft(card.expiresAt, nowMs)}</span>
          {card.tier === null ? null : ` · Tier ${String(card.tier)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* 1. The consequence comes first and is never pushed down: it is built on the server from the tool, tier and stored arguments, not from agent text. */}
        <section
          aria-label="What approving will do"
          data-testid="approval-consequence"
          data-severity={card.consequence.severity}
          className="grid gap-1 rounded-md border bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]"
        >
          <p className="font-medium" data-testid="approval-consequence-headline">
            {card.consequence.headline}
          </p>
          <p className="text-xs font-medium text-muted-foreground">{card.consequence.tierLabel}</p>
          <ul className="grid gap-0.5 text-muted-foreground">
            {card.consequence.details.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        </section>

        {/* The outcome is announced once, by the inbox's live region, so this text carries no live role. */}
        {state.kind === "decided" ? (
          <p className="text-sm font-medium" data-testid="approval-result">
            {state.decision === "approved" ? "Approved" : "Rejected"}
          </p>
        ) : null}
        {state.kind === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}

        {/* 2. The decision sits right under the consequence, above the payload, so a long payload cannot push it away. */}
        {canDecide ? (
          <p className="text-sm font-medium" data-testid="approval-details-note">
            You can&apos;t see what this call will send or change (for example the recipient or the
            message). Approving lets the agent run exactly the call it asked for.
          </p>
        ) : null}

        {canDecide ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              id={`approval-${card.id}-approve`}
              type="button"
              size="sm"
              disabled={isBusy}
              onClick={() => {
                onDecide(card.id, "approved");
              }}
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={() => {
                onDecide(card.id, "denied");
              }}
            >
              Reject
            </Button>
            <Button type="button" size="sm" variant="outline" disabled title={NOT_YET_AVAILABLE}>
              Edit
            </Button>
            <Button type="button" size="sm" variant="outline" disabled title={NOT_YET_AVAILABLE}>
              Ask
            </Button>
            {state.kind === "decided" ? (
              <Button
                ref={dismissRef}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  onDismiss(card.id);
                }}
              >
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="approval-view-only">
            You have view-only access, so you can&apos;t decide this request. Ask a workspace member
            to decide it.
          </p>
        )}

        {/* 3. The call details: a bounded region that scrolls inside the card, so its length cannot move anything above it. */}
        <section
          aria-label="Call details"
          tabIndex={0}
          data-testid="approval-payload"
          className="max-h-48 min-w-0 overflow-auto rounded-md border p-3 text-sm [overflow-wrap:anywhere]"
        >
          {card.payload.kind === "stored" ? (
            <dl className="grid gap-1" data-testid="approval-payload-lines">
              {card.payload.lines.map((line) => (
                <div key={line.key} className="grid gap-0.5">
                  <dt className="font-medium">{line.key}</dt>
                  <dd className="whitespace-pre-wrap">{line.value}</dd>
                </div>
              ))}
              {card.payload.isTruncated ? (
                <p className="text-xs text-muted-foreground">
                  Cut for display: the call has more than is shown here.
                </p>
              ) : null}
            </dl>
          ) : (
            <p>Not shown yet: the full call details are not stored yet.</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Reference <code title={card.payloadHash}>{card.payloadHash.slice(0, 12)}…</code>
          </p>
        </section>

        <dl className="grid gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="shrink-0 font-medium whitespace-nowrap">Why it stopped</dt>
            <dd data-testid="approval-reason">
              {card.reason ??
                (card.isHistoryIncomplete
                  ? "Not loaded. This run has more history than the inbox reads at once."
                  : "Not recorded")}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 font-medium whitespace-nowrap">Tool</dt>
            <dd>{card.action}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 font-medium whitespace-nowrap">Cost so far</dt>
            <dd data-testid="approval-cost">
              {formatCostMicros(card.cost.costMicros)} ·{" "}
              {(card.cost.inputTokens + card.cost.outputTokens).toLocaleString("en-US")} tokens
              {card.cost.isPartial ? " (partial: some usage is not counted)" : null}
            </dd>
          </div>
        </dl>

        <section aria-label="Recent steps" className="grid gap-1">
          <h3 className="text-sm font-medium">Recent steps</h3>
          {card.recentSteps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {card.isHistoryIncomplete
                ? "Not loaded. This run has more history than the inbox reads at once."
                : "No steps recorded."}
            </p>
          ) : (
            <ol className="grid gap-0.5 text-sm text-muted-foreground" data-testid="approval-steps">
              {card.recentSteps.map((step) => (
                <li key={step.seq} className="[overflow-wrap:anywhere]">
                  {step.label}
                </li>
              ))}
            </ol>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
