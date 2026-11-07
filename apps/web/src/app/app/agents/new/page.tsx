import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasMinRole } from "@ago/shared";

import { getAgentWizardOptions } from "../../../../features/agents/agent-library";
import { AgentWizard } from "../../../../features/agents/AgentWizard";
import { getCurrentUser } from "../../../../features/auth/current-user";
import { getActiveWorkspace } from "../../../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "New agent · Agent Office" };

// The agent creation wizard (AGO-141). Owners only: anyone else is sent back to the agent list, and the
// server action checks the role again. No request input is read here: the workspace comes from the session.
/** @no-input */
export default async function NewAgentPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");
  if (!hasMinRole(workspace.role, "owner")) redirect("/app/agents");

  const { skills, capabilities } = await getAgentWizardOptions(workspace.id);

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">New agent</h1>
        <p className="text-sm text-muted-foreground">
          Give the agent a job, choose what it may do, and set a daily budget. You review everything
          before it is created.
        </p>
      </header>
      <AgentWizard workspaceId={workspace.id} skills={skills} capabilities={capabilities} />
    </main>
  );
}
