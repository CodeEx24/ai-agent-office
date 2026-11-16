"use client";

import { useActionState, useState } from "react";
import { Button, Label } from "@ago/ui";

import { setAgentModeAction } from "./actions";
import type { AgentModeState } from "./promote-agent";

const INITIAL_STATE: AgentModeState = {};

export interface AgentModeOption {
  id: string;
  label: string;
  description: string;
}

const FIELD_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

/**
 * Autonomy of one agent (AGO-99). Every agent starts in Strict; an owner can promote it after looking over its
 * work (or demote it back). Owners only: the page does not render this for anyone else, the server action
 * checks the role again and refuses an agent credential. The confirm box is the deliberate step: nothing
 * changes until it is ticked. The options come from the page so this component stays free of the validation
 * library; the server validates the mode against the allow-list again.
 */
export function AgentModeForm({
  workspaceId,
  agentId,
  currentMode,
  modes,
  isArchived,
}: {
  workspaceId: string;
  agentId: string;
  currentMode: string;
  modes: readonly AgentModeOption[];
  isArchived: boolean;
}) {
  const [state, submit, isPending] = useActionState(setAgentModeAction, INITIAL_STATE);
  const current = modes.find((mode) => mode.id === currentMode);
  const modeError = state.fieldErrors?.mode;
  const [seenState, setSeenState] = useState(state);
  const [confirmError, setConfirmError] = useState(state.fieldErrors?.confirm);
  // Bumped after every action result. React resets a form's controls after an action, which would put the
  // select back on its mount-time option; remounting it with the right default undoes that (as AgentEditForm does).
  const [formEpoch, setFormEpoch] = useState(0);
  if (state !== seenState) {
    setSeenState(state);
    setConfirmError(state.fieldErrors?.confirm);
    setFormEpoch((epoch) => epoch + 1);
  }
  // After a change the select shows the saved mode (the key also changes with the revalidated prop, so it follows
  // whether the new mode or the action result arrives first); after a refusal it keeps what the owner picked.
  const selectedMode = state.done ? currentMode : (state.mode ?? currentMode);

  return (
    <section className="grid gap-3" aria-labelledby="agent-mode-heading">
      <h2 id="agent-mode-heading" className="text-lg font-semibold">
        Autonomy
      </h2>
      <p className="text-sm" data-testid="agent-mode">
        Current mode: <strong>{current?.label ?? "Strict"}</strong>
      </p>
      <p className="text-sm text-muted-foreground">
        New agents start in Strict. Each mode sets what this agent may do without asking. Actions at
        Tier 3 and 4 always need your approval, in every mode.
      </p>
      {isArchived ? (
        <p className="text-sm text-muted-foreground">
          This agent is archived. Unarchive it to change its mode.
        </p>
      ) : (
        <form action={submit} aria-label="Change mode" className="grid gap-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="agentId" value={agentId} />
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {state.done ? (
            <p role="status" className="text-sm text-muted-foreground">
              Mode changed. The change is logged.
            </p>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="agent-mode-select">New mode</Label>
            <select
              key={`agent-mode-select-${String(formEpoch)}-${currentMode}`}
              id="agent-mode-select"
              name="mode"
              defaultValue={selectedMode}
              className={FIELD_CLASS}
              aria-invalid={Boolean(modeError)}
              aria-describedby={modeError ? "agent-mode-select-error" : undefined}
            >
              {modes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label} - {mode.description}
                </option>
              ))}
            </select>
            {modeError ? (
              <p id="agent-mode-select-error" role="alert" className="text-sm text-destructive">
                {modeError}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <label className="flex items-start gap-2 text-sm" htmlFor="agent-mode-confirm">
              <input
                id="agent-mode-confirm"
                name="confirm"
                type="checkbox"
                className="mt-1"
                onChange={(event) => {
                  // A refusal left over from an earlier submit is about the old, unticked box.
                  if (event.target.checked) setConfirmError(undefined);
                }}
                aria-invalid={Boolean(confirmError)}
                aria-describedby={confirmError ? "agent-mode-confirm-error" : undefined}
              />
              <span>I have decided to change this agent&apos;s mode.</span>
            </label>
            {confirmError ? (
              <p id="agent-mode-confirm-error" role="alert" className="text-sm text-destructive">
                {confirmError}
              </p>
            ) : null}
          </div>
          <div>
            <Button type="submit" size="sm" disabled={isPending}>
              Change mode
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
