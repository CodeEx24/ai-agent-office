"use client";

import { useActionState } from "react";
import { AGENT_TEMPLATES } from "@ago/shared/agent-templates";
import { Button } from "@ago/ui";

import { createAgentFromTemplateAction } from "./actions";
import type { AgentWizardState } from "./create-agent";

const INITIAL_STATE: AgentWizardState = {};

/**
 * One-click "Create from template" (AGO-136): eight role cards, one button each. Owners only: the agents page
 * does not render it for anyone else, and the server action checks the role again. The agent is created in
 * Strict mode with the template's minimal capabilities; nothing here can say otherwise. To review or change
 * the details first, use the template picker in the wizard instead.
 */
export function TemplateGallery({ workspaceId }: { workspaceId: string }) {
  const [state, action, isPending] = useActionState(createAgentFromTemplateAction, INITIAL_STATE);

  return (
    <section aria-labelledby="templates-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="templates-heading" className="text-lg font-semibold">
          Create from a template
        </h2>
        <p className="text-sm text-muted-foreground">
          One click creates a ready agent in Strict mode with only the permissions its role needs.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2" data-testid="template-list">
        {AGENT_TEMPLATES.map((template) => (
          <li key={template.id} className="min-w-0 rounded-md border p-3">
            <form action={action} className="grid gap-2" aria-label={`Create ${template.name}`}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="templateId" value={template.id} />
              <div className="grid gap-0.5">
                <span className="font-medium">{template.name}</span>
                <span className="text-sm text-muted-foreground">{template.summary}</span>
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={isPending}>
                Create {template.name}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
