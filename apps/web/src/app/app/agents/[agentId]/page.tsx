import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { hasMinRole } from "@ago/shared";

import { AgentEditForm } from "../../../../features/agents/AgentEditForm";
import { AgentVersionList } from "../../../../features/agents/AgentVersionList";
import { AgentLibraryError, getAgentDetail } from "../../../../features/agents/agent-library";
import { getCurrentUser } from "../../../../features/auth/current-user";
import { getActiveWorkspace } from "../../../../features/workspaces/workspace-access";
import { parseInput } from "../../../../lib/validation/parse-input";

export const metadata: Metadata = { title: "Agent · Agent Office" };

const paramsSchema = z.strictObject({ agentId: z.uuid() });

// One agent (AGO-89): edit its settings (owners) or read them (everyone), and its version history.
export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const parsed = parseInput(paramsSchema, await params);
  if (!parsed.success) notFound();

  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  let detail;
  try {
    detail = await getAgentDetail(workspace.id, parsed.data.agentId);
  } catch (error) {
    if (error instanceof AgentLibraryError && error.code === "not_found") notFound();
    throw error;
  }

  const { agent, versions } = detail;
  const canEdit = hasMinRole(workspace.role, "owner");

  return (
    <main className="mx-auto grid max-w-3xl gap-8 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <Link
          href="/app/agents"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All agents
        </Link>
        <h1
          className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]"
          data-testid="agent-name"
        >
          {agent.name}
        </h1>
        <p className="text-sm text-muted-foreground" data-testid="agent-version">
          Version {agent.version}
          {agent.isArchived ? " · Archived" : ""}
        </p>
      </header>

      {canEdit ? (
        <AgentEditForm workspaceId={workspace.id} agent={agent} />
      ) : (
        <p className="text-sm text-muted-foreground">Only workspace owners can edit agents.</p>
      )}

      <section className="grid gap-2" aria-labelledby="agent-history-heading">
        <h2 id="agent-history-heading" className="text-lg font-semibold">
          History
        </h2>
        <AgentVersionList versions={versions} />
      </section>
    </main>
  );
}
