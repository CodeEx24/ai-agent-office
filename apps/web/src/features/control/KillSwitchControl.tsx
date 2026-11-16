"use client";

import { useState } from "react";
import { killSwitchResponseSchema } from "@ago/shared";
import { Button } from "@ago/ui";

type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "working" }
  | { kind: "done"; runsStopped: number; credentialsRevoked: number }
  | { kind: "failed"; message: string };

const FAILURE_MESSAGES: Readonly<Record<number, string>> = {
  401: "You are signed out. Sign in again, then try once more.",
  403: "Only a workspace owner can use the kill switch.",
};

/**
 * The kill switch button (AGO-84). Owners only: the page renders it for owners and the route checks the role again.
 * It never fires on one click: the first click asks for a confirmation that says exactly what will happen, the
 * second one calls `POST /api/control/kill`. With an `agent` it covers that agent only; without one, the whole
 * workspace. It does not undo anything: releasing the switch is a separate owner action and never revives a run.
 */
export function KillSwitchControl({
  workspaceId,
  agent,
}: {
  workspaceId: string;
  agent?: { id: string; name: string };
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const scopeLabel = agent ? `agent ${agent.name}` : "this workspace";

  async function activate(): Promise<void> {
    setPhase({ kind: "working" });
    try {
      const response = await fetch("/api/control/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          agent
            ? { workspace_id: workspaceId, scope: "agent", agent_id: agent.id }
            : { workspace_id: workspaceId, scope: "workspace" },
        ),
      });
      if (!response.ok) {
        setPhase({
          kind: "failed",
          message:
            FAILURE_MESSAGES[response.status] ??
            "The kill switch could not be recorded. Nothing was changed; try again.",
        });
        return;
      }
      const parsed = killSwitchResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        setPhase({ kind: "failed", message: "The answer was not understood. Check the runs." });
        return;
      }
      setPhase({
        kind: "done",
        runsStopped: parsed.data.runs_stopped,
        credentialsRevoked: parsed.data.credentials_revoked,
      });
    } catch {
      setPhase({
        kind: "failed",
        message: "The kill switch could not be reached. Nothing was changed; try again.",
      });
    }
  }

  if (phase.kind === "done") {
    return (
      <p role="status" className="text-sm">
        Kill switch active for {scopeLabel}: {phase.runsStopped} runs are stopping and{" "}
        {phase.credentialsRevoked} credentials were revoked. Nothing was deleted.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {phase.kind === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {phase.message}
        </p>
      ) : null}
      {phase.kind === "confirming" || phase.kind === "working" ? (
        <div role="group" aria-label="Confirm kill switch" className="grid gap-2">
          <p className="text-sm">
            This stops every run of {scopeLabel}, revokes its credentials and blocks new runs until
            an owner releases it. Stopped runs cannot be resumed. All records are kept.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={phase.kind === "working"}
              onClick={() => void activate()}
            >
              Confirm kill
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase.kind === "working"}
              onClick={() => {
                setPhase({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => {
            setPhase({ kind: "confirming" });
          }}
        >
          Kill switch
        </Button>
      )}
    </div>
  );
}
