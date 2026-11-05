"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@ago/ui";

import { createWorkspaceAction, type OnboardingState } from "./actions";

const INITIAL_STATE: OnboardingState = {};

/** First-run form: name the workspace. Submitting makes the user its owner. */
export function OnboardingForm({ defaultName }: { defaultName: string }) {
  const [state, action, isPending] = useActionState(createWorkspaceAction, INITIAL_STATE);

  return (
    <form action={action} className="grid gap-3">
      <Label htmlFor="workspace-name">Workspace name</Label>
      <Input
        id="workspace-name"
        name="name"
        defaultValue={defaultName}
        maxLength={120}
        required
        aria-invalid={Boolean(state.error)}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
