"use client";

import { useActionState } from "react";
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
 * Autonomy of one agent (AGO-99). Every agent starts in Strict; an owner can promote it after reviewing its
 * runs (or demote it back). Owners only: the page does not render this for anyone else, the server action
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
  const confirmError = state.fieldErrors?.confirm;

  return (
    <section className="grid gap-3" aria-labelledby="agent-mode-heading">
      <h2 id="agent-mode-heading" className="text-lg font-semibold">
        Autonomy
      </h2>
      <p className="text-sm" data-testid="agent-mode">
        Current mode: <strong>{current?.label ?? "Strict"}</strong>
      </p>
      <p className="text-sm text-muted-foreground">
        New agents start in Strict. Review what this agent has done in its runs before you promote
        it. Actions at Tier 3 and 4 always need your approval, in every mode.
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
              id="agent-mode-select"
              name="mode"
              defaultValue={currentMode}
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
                aria-invalid={Boolean(confirmError)}
                aria-describedby={confirmError ? "agent-mode-confirm-error" : undefined}
              />
              <span>I reviewed this agent&apos;s runs and want to change its mode.</span>
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
