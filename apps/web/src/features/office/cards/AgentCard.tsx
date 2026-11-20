import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ago/ui";
import type { AgentOfficeState } from "@ago/shared";

import { getAgentStateView } from "./agent-state-view";
import { AgentStateBadge } from "./AgentStateBadge";
import { approvalHref } from "./approval-link";

/** The agent a card is for (from the workspace's agent list, not from run events). */
export interface AgentCardAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

/**
 * One agent card (AGO-150). `office` is the agent's state from the office store, or null when no run of it is
 * known (shown as Idle). `isLoading` shows a placeholder instead of a state we do not know yet, so a card never
 * claims Idle before the first events arrive.
 *
 * Every string here (names, the detail code) is rendered as React text, never as HTML or Markdown: they can trace
 * back to agent output. "Waiting on you" is a link that only navigates to the approvals inbox; deciding happens
 * there, on the human-only route.
 */
export function AgentCard({
  agent,
  office,
  isLoading = false,
}: {
  agent: AgentCardAgent;
  office: AgentOfficeState | null;
  isLoading?: boolean;
}) {
  const state = office?.state ?? "idle";
  const view = getAgentStateView(state);
  const titleId = `agent-card-${agent.id}-title`;

  return (
    <Card
      role="listitem"
      aria-labelledby={titleId}
      data-testid="agent-card"
      data-state={isLoading ? "loading" : state}
      className="min-w-0 gap-3 py-4 [&_*]:[overflow-wrap:anywhere]"
    >
      <CardHeader className="gap-0.5">
        <CardTitle id={titleId} className="text-base">
          {agent.name}
        </CardTitle>
        <CardDescription>{agent.role}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground" data-testid="agent-state-loading">
            Loading state…
          </p>
        ) : state === "waiting_on_you" ? (
          <>
            <Link
              href={approvalHref(office?.approval_id ?? null)}
              aria-label={`Agent state: ${view.label}. Open the approval request for ${agent.name}.`}
              data-testid="agent-approval-link"
              className="w-fit rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <AgentStateBadge state={state} />
            </Link>
            <p className="text-sm text-muted-foreground">
              {view.description} Opening it does not approve anything.
            </p>
          </>
        ) : (
          <>
            <AgentStateBadge state={state} className="w-fit" />
            <p className="text-sm text-muted-foreground">{view.description}</p>
          </>
        )}
        {!isLoading && office?.detail ? (
          <p className="text-sm" data-testid="agent-state-detail">
            Reason: <code>{office.detail}</code>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
