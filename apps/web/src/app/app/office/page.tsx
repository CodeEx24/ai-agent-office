import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listAgents } from "../../../features/agents/agent-library";
import { getCurrentUser } from "../../../features/auth/current-user";
import { OfficeCardsLive } from "../../../features/office/cards";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";
import { getSupabasePublicEnv } from "../../../lib/env";

export const metadata: Metadata = { title: "Office · Agent Office" };

// The flat view (AGO-150): one card per agent with its live state. The agent list comes from the signed-in user's
// workspace; the states come from the office store in the browser. No request input is read here.
/** @no-input */
export default async function OfficePage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const agents = await listAgents(workspace.id);
  const { url, anonKey } = getSupabasePublicEnv();

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Office</h1>
        <p className="text-sm text-muted-foreground">
          What every agent is doing right now. Each state has its own icon and label, so you never
          have to rely on color.
        </p>
      </header>
      <OfficeCardsLive
        workspaceId={workspace.id}
        agents={agents.map(({ id, name, role }) => ({ id, name, role }))}
        supabaseUrl={url}
        supabaseAnonKey={anonKey}
      />
    </main>
  );
}
