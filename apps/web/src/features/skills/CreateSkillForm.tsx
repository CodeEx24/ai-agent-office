"use client";

import { useActionState } from "react";
import {
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from "@ago/shared/skills";
import { Button, Input, Label } from "@ago/ui";

import { createSkillAction, type SkillActionState } from "./actions";

const INITIAL_STATE: SkillActionState = {};

/** New skill form. Owners only (the page does not render it for anyone else). */
export function CreateSkillForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, isPending] = useActionState(createSkillAction, INITIAL_STATE);

  return (
    <form action={action} className="grid gap-3" aria-label="New skill">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Label htmlFor="new-skill-name">Name</Label>
      <Input
        id="new-skill-name"
        name="name"
        maxLength={SKILL_NAME_MAX_LENGTH}
        required
        aria-invalid={Boolean(state.error)}
      />
      <Label htmlFor="new-skill-description">Description</Label>
      <Input
        id="new-skill-description"
        name="description"
        maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
      />
      <Label htmlFor="new-skill-body">Skill text (Markdown)</Label>
      <textarea
        id="new-skill-body"
        name="body"
        maxLength={SKILL_BODY_MAX_LENGTH}
        spellCheck={false}
        className="min-h-32 w-full rounded-md border border-input bg-transparent p-3 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating…" : "Create skill"}
        </Button>
      </div>
    </form>
  );
}
