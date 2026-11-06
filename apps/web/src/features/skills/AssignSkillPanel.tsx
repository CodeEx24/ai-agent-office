"use client";

import { useActionState } from "react";
import type { SkillAssignment } from "@ago/shared";
import { Button, Label } from "@ago/ui";

import { assignSkillAction, unassignSkillAction, type SkillActionState } from "./actions";

const INITIAL_STATE: SkillActionState = {};

interface AssignSkillPanelProps {
  workspaceId: string;
  skillId: string;
  assignments: SkillAssignment[];
  /** Active agents in the workspace. */
  agents: { id: string; name: string }[];
  /** Owners can assign and remove; everyone else sees the list only. */
  canEdit: boolean;
}

function RemoveButton({
  workspaceId,
  skillId,
  agent,
}: {
  workspaceId: string;
  skillId: string;
  agent: SkillAssignment;
}) {
  const [state, action, isPending] = useActionState(unassignSkillAction, INITIAL_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="skillId" value={skillId} />
      <input type="hidden" name="agentId" value={agent.agentId} />
      <Button type="submit" variant="outline" size="sm" disabled={isPending}>
        Remove<span className="sr-only"> from {agent.agentName}</span>
      </Button>
      {state.error ? (
        <span role="alert" className="text-sm text-destructive">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

/** Which agents have this skill, with assign and remove for owners. Assignments follow the latest version. */
export function AssignSkillPanel({
  workspaceId,
  skillId,
  assignments,
  agents,
  canEdit,
}: AssignSkillPanelProps) {
  const [state, action, isPending] = useActionState(assignSkillAction, INITIAL_STATE);
  const assignedIds = new Set(assignments.map((a) => a.agentId));
  const available = agents.filter((agent) => !assignedIds.has(agent.id));

  return (
    <section className="grid gap-3" aria-label="Assigned agents">
      <h2 className="text-lg font-semibold">Agents with this skill</h2>
      {assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agent has this skill yet.</p>
      ) : (
        <ul className="grid gap-2" data-testid="assignments">
          {assignments.map((assignment) => (
            <li
              key={assignment.agentId}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{assignment.agentName}</span>
              {canEdit ? (
                <RemoveButton workspaceId={workspaceId} skillId={skillId} agent={assignment} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        available.length > 0 ? (
          <form
            action={action}
            className="flex flex-wrap items-end gap-2"
            aria-label="Assign to an agent"
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="skillId" value={skillId} />
            <div className="grid gap-1">
              <Label htmlFor="assign-agent">Agent</Label>
              <select
                id="assign-agent"
                name="agentId"
                required
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              >
                {available.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Assigning…" : "Assign"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Every active agent already has this skill.
          </p>
        )
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
