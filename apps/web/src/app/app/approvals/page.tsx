import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../../features/auth/current-user";
import { ApprovalInbox } from "../../../features/approvals/ApprovalInbox";
import { listPendingApprovals } from "../../../features/approvals/inbox-data";
import { getActiveWorkspace } from "../../../features/workspaces/workspace-access";

export const metadata: Metadata = { title: "Approvals · Agent Office" };

// The approvals inbox (AGO-37): what agents are waiting to do, until a person decides. The workspace comes from the
// signed-in user's membership; no request input is read here. Decisions go through the human-only decide route.
/** @no-input */
export default async function ApprovalsPage() {
  const user = await getCurrentUser();
  const workspace = user ? await getActiveWorkspace(user.id) : null;
  if (!workspace) redirect("/app");

  const inbox = await listPendingApprovals(workspace.id);

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-8 [&>*]:min-w-0">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Agents stop here before a risky action. Nothing runs until a person approves it, and a
          request nobody answers is denied when it times out.
        </p>
      </header>
      <ApprovalInbox
        workspaceId={inbox.workspaceId}
        cards={inbox.cards}
        canDecide={inbox.canDecide}
        serverNowMs={inbox.generatedAtMs}
      />
    </main>
  );
}
