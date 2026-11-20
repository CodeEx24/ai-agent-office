"use client";

import { useOfficeConnection, useOfficeStore, selectOfficeAgentStates } from "../store";
import type { OfficeEventSource, OfficeRealtimeStatus } from "../realtime/office-event-source";
import { AgentCard, type AgentCardAgent } from "./AgentCard";

/** What the person is told about the live stream. `null`: nothing to say (the stream is live). */
export function streamNotice(status: OfficeRealtimeStatus): string | null {
  switch (status) {
    case "idle":
    case "connecting":
      return "Connecting to live updates…";
    case "catching_up":
      return "Catching up with recent activity…";
    case "reconnecting":
      return "Connection lost. Reconnecting; the states below may be out of date.";
    case "stopped":
      return "Live updates have stopped. The states below may be out of date. Reload the page to reconnect.";
    case "live":
      return null;
  }
}

/**
 * The agent cards of one workspace (AGO-150). State comes only from the office store: this component connects the
 * store to `source` while mounted and reads the six-state view through the store hooks. It never reads run events
 * itself. `source` must be stable (create it once).
 */
export function AgentCardGrid({
  workspaceId,
  agents,
  source,
}: {
  workspaceId: string;
  agents: readonly AgentCardAgent[];
  source: OfficeEventSource;
}) {
  useOfficeConnection(workspaceId, source);
  const states = useOfficeStore(selectOfficeAgentStates);
  const status = useOfficeStore((s) => s.status);

  const isLoading = status === "idle" || status === "connecting";
  const notice = streamNotice(status);

  return (
    <div className="grid gap-4">
      {/* Always mounted so a change of connection state is announced. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="office-stream-status"
        data-status={status}
        className={notice === null ? "sr-only" : "text-sm text-muted-foreground"}
      >
        {notice ?? "Live updates are on."}
      </p>
      {agents.length === 0 ? (
        <p className="text-muted-foreground" data-testid="agent-cards-empty">
          No agents yet. Hire one on the Agents page and it will show up here.
        </p>
      ) : (
        <div
          role="list"
          aria-label="Agents"
          data-testid="agent-card-grid"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              office={states[agent.id] ?? null}
              isLoading={isLoading}
            />
          ))}
        </div>
      )}
    </div>
  );
}
