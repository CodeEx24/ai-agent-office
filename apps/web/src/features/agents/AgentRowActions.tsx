"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AGENT_FIELD_LABELS, AGENT_NAME_MAX_LENGTH } from "@ago/shared/agent-limits";
import { Button, Input, Label } from "@ago/ui";

import { archiveAgentAction, duplicateAgentAction, unarchiveAgentAction } from "./actions";
import type { AgentEditState } from "./edit-agent";

const INITIAL_STATE: AgentEditState = {};

/**
 * Owner actions on one row of the agent list (AGO-89): edit, duplicate (the copy starts in Strict mode with
 * the same skills and capabilities) and archive, or unarchive for an archived agent. Owners only: the page
 * does not render this for anyone else and every action checks the role again. Archive is reversible, so it
 * has no confirmation step; it says what it does instead.
 */
export function AgentRowActions({
  workspaceId,
  agent,
}: {
  workspaceId: string;
  agent: { id: string; name: string; isArchived: boolean };
}) {
  const [archiveState, archive, isArchiving] = useActionState(archiveAgentAction, INITIAL_STATE);
  const [unarchiveState, unarchive, isUnarchiving] = useActionState(
    unarchiveAgentAction,
    INITIAL_STATE,
  );
  const [duplicateState, duplicate, isDuplicating] = useActionState(
    duplicateAgentAction,
    INITIAL_STATE,
  );
  const error = archiveState.error ?? unarchiveState.error ?? duplicateState.error;
  const nameError = duplicateState.fieldErrors?.name;
  const nameErrorId = `duplicate-${agent.id}-error`;

  return (
    <div className="grid gap-2">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/app/agents/${agent.id}`}
          className="text-sm text-primary underline underline-offset-4"
          aria-label={`${agent.isArchived ? "View" : "Edit"} ${agent.name}`}
        >
          {agent.isArchived ? "View" : "Edit"}
        </Link>
        {agent.isArchived ? (
          <form action={unarchive} aria-label={`Unarchive ${agent.name}`}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <Button type="submit" variant="outline" size="sm" disabled={isUnarchiving}>
              Unarchive
            </Button>
          </form>
        ) : (
          <form action={archive} aria-label={`Archive ${agent.name}`}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={isArchiving}
              title="Archived agents keep their history but cannot receive tasks. You can unarchive them."
            >
              Archive
            </Button>
          </form>
        )}
      </div>
      {agent.isArchived ? null : (
        <details>
          <summary className="cursor-pointer text-sm text-primary underline underline-offset-4">
            Duplicate {agent.name}
          </summary>
          <form
            action={duplicate}
            aria-label={`Duplicate ${agent.name}`}
            className="mt-2 grid gap-2"
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <Label htmlFor={`duplicate-${agent.id}-name`}>
              {AGENT_FIELD_LABELS.name} of the copy
            </Label>
            <Input
              id={`duplicate-${agent.id}-name`}
              name="name"
              defaultValue={`${agent.name} copy`.slice(0, AGENT_NAME_MAX_LENGTH)}
              maxLength={AGENT_NAME_MAX_LENGTH}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? nameErrorId : undefined}
              autoComplete="off"
            />
            {nameError ? (
              <p id={nameErrorId} role="alert" className="text-sm text-destructive">
                {nameError}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              The copy has the same settings, skills and capabilities, and starts in Strict mode.
            </p>
            <div>
              <Button type="submit" size="sm" disabled={isDuplicating}>
                Create copy
              </Button>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
