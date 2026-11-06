"use client";

import { useActionState, useState } from "react";
import { SKILL_BODY_MAX_LENGTH, SKILL_DESCRIPTION_MAX_LENGTH } from "@ago/shared/skill-limits";
import { Button, Input, Label } from "@ago/ui";

import { saveSkillAction, type SkillActionState } from "./actions";
import { MarkdownPreview } from "./MarkdownPreview";

const INITIAL_STATE: SkillActionState = {};

const TEXTAREA_CLASS =
  "min-h-64 w-full rounded-md border border-input bg-transparent p-3 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

interface SkillEditorProps {
  workspaceId: string;
  skillId: string;
  /** The version the page loaded. Sent back so a stale editor cannot overwrite a newer save. */
  version: number;
  description: string;
  body: string;
}

/**
 * Edit a skill with a live Markdown preview beside the text. Saving a changed text stores a new
 * version; the old ones stay. Only rendered for owners: members and viewers get the read-only view.
 */
export function SkillEditor({
  workspaceId,
  skillId,
  version,
  description,
  body,
}: SkillEditorProps) {
  const [state, action, isPending] = useActionState(saveSkillAction, INITIAL_STATE);
  const [draft, setDraft] = useState(body);

  return (
    <form action={action} className="grid min-w-0 gap-4" aria-label="Edit skill">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="skillId" value={skillId} />
      <input type="hidden" name="expectedVersion" value={version} />

      <div className="grid min-w-0 gap-2">
        <Label htmlFor="skill-description">Description</Label>
        <Input
          id="skill-description"
          name="description"
          defaultValue={description}
          maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="grid content-start gap-2">
          <Label htmlFor="skill-body">Skill text (Markdown)</Label>
          <textarea
            id="skill-body"
            name="body"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            maxLength={SKILL_BODY_MAX_LENGTH}
            spellCheck={false}
            className={TEXTAREA_CLASS}
          />
          <p className="text-xs text-muted-foreground">
            {draft.length.toLocaleString("en-US")} / {SKILL_BODY_MAX_LENGTH.toLocaleString("en-US")}{" "}
            characters
          </p>
        </div>
        <section className="grid content-start gap-2" aria-label="Preview">
          <h2 className="text-sm font-medium">Preview</h2>
          <div className="min-h-64 min-w-0 overflow-x-auto rounded-md border p-3">
            <MarkdownPreview text={draft} />
          </div>
        </section>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.savedVersion ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="save-status">
          Saved. This skill is at version {state.savedVersion}.
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
