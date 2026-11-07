import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AGENT_MODELS, hasMinRole } from "@ago/shared";

import { listAgents } from "../../../features/agents/agent-library";
import { TemplateGallery } from "../../../features/agents/TemplateGallery";
import { getCurrentUser } from "../../../features/auth/current-user";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "Agents · Agent Office" };

// The agents of the workspace (AGO-141). Everyone in the workspace can read; only owners can hire an agent.
// No request input is read here: the workspace comes from the signed-in user's membership.
/** @no-input */
export default async function AgentsPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const agents = await listAgents(workspace.id);
  const canCreate = hasMinRole(workspace.role, "owner");

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          The AI agents in your workspace. Every new agent starts in Strict mode.
        </p>
      </header>

      {agents.length === 0 ? (
        <p className="text-muted-foreground">No agents yet.</p>
      ) : (
        <ul className="grid min-w-0 gap-2" data-testid="agent-list">
          {agents.map((agent) => (
            <li key={agent.id} className="min-w-0 rounded-md border px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium [overflow-wrap:anywhere]">{agent.name}</span>
                <span className="text-xs text-muted-foreground" data-testid="agent-mode">
                  {agent.mode === "strict" ? "Strict" : agent.mode}
                </span>
              </div>
              <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                {[
                  agent.role,
                  AGENT_MODELS.find((model) => model.id === agent.model)?.id ?? agent.model,
                  agent.dailyBudgetCents === null
                    ? null
                    : `$${(agent.dailyBudgetCents / 100).toFixed(2)} a day`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canCreate ? (
        <>
          <TemplateGallery workspaceId={workspace.id} />
          <p>
            <Link href="/app/agents/new" className="text-primary underline underline-offset-4">
              New agent
            </Link>
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Only workspace owners can create agents.</p>
      )}
    </main>
  );
}
