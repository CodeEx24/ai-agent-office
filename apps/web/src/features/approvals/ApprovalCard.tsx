import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ago/ui";

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
  state,
  onDecide,
}: {
  card: ApprovalCardData;
  nowMs: number;
  canDecide: boolean;
  state: CardDecisionState;
  onDecide: (id: string, decision: "approved" | "denied") => void;
}) {
  const isBusy = state.kind === "sending" || state.kind === "decided";
  const titleId = `approval-${card.id}-title`;

  return (
    <Card
      role="listitem"
      aria-labelledby={titleId}
      data-testid="approval-card"
      className="min-w-0 [&_*]:[overflow-wrap:anywhere]"
    >
      <CardHeader>
        <CardTitle id={titleId} className="text-base">
          {card.agentName} wants to run {card.action}
        </CardTitle>
        <CardDescription>
          <span data-testid="approval-age">Waiting {formatAge(card.createdAt, nowMs)}</span>
          {" · "}
          <span data-testid="approval-time-left">{formatTimeLeft(card.expiresAt, nowMs)}</span>
          {card.tier === null ? null : ` · Tier ${String(card.tier)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="font-medium">Why it stopped</dt>
            <dd data-testid="approval-reason">{card.reason ?? "Not recorded"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Tool</dt>
            <dd>{card.action}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Payload</dt>
            <dd data-testid="approval-payload">
              <code title={card.payloadHash}>{card.payloadHash.slice(0, 12)}…</code>{" "}
              <span className="text-muted-foreground">
                (fingerprint of the exact call; the full payload is not stored yet)
              </span>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Cost so far</dt>
            <dd data-testid="approval-cost">
              {formatCostMicros(card.cost.costMicros)} ·{" "}
              {(card.cost.inputTokens + card.cost.outputTokens).toLocaleString("en-US")} tokens
            </dd>
          </div>
        </dl>

        <section aria-label="Recent steps" className="grid gap-1">
          <h3 className="text-sm font-medium">Recent steps</h3>
          {card.recentSteps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps recorded.</p>
          ) : (
            <ol className="grid gap-0.5 text-sm text-muted-foreground" data-testid="approval-steps">
              {card.recentSteps.map((step) => (
                <li key={step.seq}>{step.label}</li>
              ))}
            </ol>
          )}
        </section>

        {state.kind === "decided" ? (
          <p role="status" className="text-sm font-medium" data-testid="approval-result">
            {state.decision === "approved" ? "Approved" : "Rejected"}
          </p>
        ) : null}
        {state.kind === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}

        {canDecide ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only members can decide an approval.</p>
        )}
      </CardContent>
    </Card>
  );
}
