"use client";

import { useActionState, useId, useState, type SubmitEvent } from "react";
import Link from "next/link";
import {
  GOAL_MESSAGES,
  GOAL_TEXT_MAX_LENGTH,
  checkGoalText,
  countGoalCharacters,
} from "@ago/shared/goal-limits";
import { Button, Label } from "@ago/ui";

import { submitGoalAction } from "./actions";
import type { GoalInboxState } from "./submit-goal";

const INITIAL_STATE: GoalInboxState = {};

const FIELD_CLASS =
  "min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

/**
 * The goal inbox form (AGO-113): one text box and a Submit button. An empty goal (nothing, spaces or only
 * zero-width characters) is refused here with a message under the box, before any request; the server action and
 * the database refuse it again. The text is plain data: it is never rendered as markup. The box is cleared once
 * the goal is recorded.
 */
export function GoalInboxForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, isPending] = useActionState(submitGoalAction, INITIAL_STATE);
  const [text, setText] = useState("");
  const [clientError, setClientError] = useState<string | undefined>();
  const [seenState, setSeenState] = useState(state);
  const textId = useId();
  const errorId = `${textId}-error`;

  // A new server answer arrived: a recorded goal clears the box. Compared during render, not in an effect.
  if (state !== seenState) {
    setSeenState(state);
    if (state.submittedId) {
      setText("");
      setClientError(undefined);
    }
  }

  const fieldError = clientError ?? state.fieldError;
  const showSuccess = state.submittedId !== undefined && clientError === undefined && text === "";

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    const check = checkGoalText(text);
    if (!check.ok) {
      event.preventDefault();
      setClientError(check.message);
      return;
    }
    setClientError(undefined);
  }

  return (
    <form action={action} onSubmit={onSubmit} noValidate className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="grid gap-1.5">
        <Label htmlFor={textId}>Goal</Label>
        <textarea
          id={textId}
          name="text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (clientError) setClientError(undefined);
          }}
          rows={5}
          placeholder="What should the team achieve? The Manager will turn it into tasks."
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? errorId : undefined}
          className={FIELD_CLASS}
          disabled={isPending}
        />
        <div className="flex items-start justify-between gap-3">
          <p
            id={errorId}
            role="alert"
            className="min-h-5 text-sm text-destructive"
            data-testid="goal-field-error"
          >
            {fieldError}
          </p>
          <p className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">
            {countGoalCharacters(text)}/{GOAL_TEXT_MAX_LENGTH}
          </p>
        </div>
      </div>

      {state.error ? (
        <div className="grid gap-1">
          <p role="alert" className="text-sm text-destructive" data-testid="goal-form-error">
            {state.error}
          </p>
          {state.error === GOAL_MESSAGES.noManager ? (
            <Link
              href="/app/agents/new"
              className="text-sm text-primary underline underline-offset-4"
              data-testid="goal-create-manager-link"
            >
              Create a Manager agent
            </Link>
          ) : null}
        </div>
      ) : null}
      {showSuccess ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="goal-submitted">
          Goal submitted. The Manager has a task to turn it into work.
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Submitting…" : "Submit goal"}
        </Button>
      </div>
    </form>
  );
}
