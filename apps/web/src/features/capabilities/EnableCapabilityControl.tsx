"use client";

import { useActionState } from "react";
import { Button } from "@ago/ui";

import { enableCapabilityAction } from "./actions";
import type { EnableCapabilityState } from "./enable-capability";

const INITIAL_STATE: EnableCapabilityState = {};

export interface EnableCapabilityControlProps {
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly isEnabled: boolean;
  /** Labels of the prerequisites that do not pass right now (empty when the capability may be enabled). */
  readonly blockedBy: readonly string[];
}

/**
 * Owner control to turn a capability on (AGO-85). The button is disabled while any prerequisite fails, with the
 * failing checks listed; that is a courtesy, not the gate: the server action re-checks at enable time and the
 * worker re-checks at every tool call. The form carries two ids and nothing else.
 */
export function EnableCapabilityControl({
  workspaceId,
  capabilityId,
  name,
  isEnabled,
  blockedBy,
}: EnableCapabilityControlProps) {
  const [state, action, isPending] = useActionState(enableCapabilityAction, INITIAL_STATE);
  const isOn = isEnabled || state.done === true;
  const failed = state.failedChecks ?? [];
  const shownBlockers = blockedBy.length > 0 ? blockedBy : failed;
  const isBlocked = shownBlockers.length > 0;

  if (isOn) {
    return <span className="text-sm font-medium">Enabled</span>;
  }

  return (
    <form action={action} className="grid gap-1" aria-label={`Enable ${name}`}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="capabilityId" value={capabilityId} />
      <Button
        type="submit"
        disabled={isPending || isBlocked}
        aria-describedby={`why-${capabilityId}`}
      >
        {isPending ? "Checking…" : "Enable"}
      </Button>
      <div id={`why-${capabilityId}`} className="text-xs text-muted-foreground">
        {isBlocked ? (
          <>
            <p>Blocked until these checks pass:</p>
            <ul className="list-disc pl-4" data-testid="blocked-checks">
              {shownBlockers.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </>
        ) : null}
        {state.error && !isBlocked ? (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
